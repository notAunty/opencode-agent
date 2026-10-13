import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import type { EventEmitter } from "node:events"
import { IncomingMessage } from "node:http"
import { Socket as NetworkSocket } from "node:net"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createSlackAdapter } from "@chat-adapter/slack"
import { chatLogger, createChatAdapters } from "../src/chat.js"
import { createSocketSlackAdapter } from "../src/chat-slack.js"
import { captureFile } from "../src/transfers.js"
import type { Storage } from "../src/contracts.js"
import { messagingFixture, eventually, fixtureStorage } from "./messaging-fixture.js"

interface Socket extends EventEmitter { start(): Promise<unknown>; disconnect(): Promise<void> }
// Resolve the SDK's own dependency, not a second socket client with a different prototype.
const sdkRequire = createRequire(import.meta.resolve("@chat-adapter/slack"))
const { SocketModeClient } = sdkRequire("@slack/socket-mode") as { SocketModeClient: { prototype: Socket } }
const { WebClient } = sdkRequire("@slack/web-api") as { WebClient: { prototype: { apiCall(method: string, payload?: Record<string, unknown>): Promise<unknown> } } }

async function fixture(startFails = false, storage: Storage = fixtureStorage(), downloadGate?: Promise<void>) {
  const original = { start: SocketModeClient.prototype.start, disconnect: SocketModeClient.prototype.disconnect, apiCall: WebClient.prototype.apiCall }
  const sockets: Socket[] = []; let disconnects = 0; let acks = 0
  const posts: Record<string, unknown>[] = []; const calls: string[] = []
  const files: { thread: string; message: unknown }[] = []; let downloads = 0
  SocketModeClient.prototype.start = async function () {
    sockets.push(this)
    if (startFails) throw new Error("synthetic secret must not escape")
    return { ok: true }
  }
  SocketModeClient.prototype.disconnect = async () => { disconnects++ }
  WebClient.prototype.apiCall = async (method, payload = {}) => {
    calls.push(method)
    if (method === "auth.test") return { ok: true, user_id: "BOT", user: "synthetic_bot" }
    if (method === "users.info") return { ok: true, user: { id: payload.user, name: String(payload.user), profile: { display_name: String(payload.user) } } }
    if (method === "chat.postMessage") { posts.push(payload); return { ok: true, ts: String(posts.length), channel: payload.channel, message: { text: payload.text ?? "" } } }
    throw new Error(`Unexpected synthetic API call: ${method}`)
  }
  const f = await messagingFixture("slack", { adapters: (_, env, waitUntil) => {
    const adapter = createSocketSlackAdapter({ mode: "socket", botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN, logger: chatLogger("slack"),
      fileTransport: async () => {
        downloads++
        await downloadGate
        const response = new IncomingMessage(new NetworkSocket())
        response.statusCode = 200; response.headers = { "content-type": "image/png" }
        response.push(Buffer.from("synthetic image")); response.push(null)
        return response
      },
    }, waitUntil)
    const post = adapter.postMessage.bind(adapter)
    adapter.postMessage = async (thread, message) => {
      if (typeof message === "object" && "files" in message) {
        files.push({ thread, message })
        return { id: "synthetic-file", threadId: thread, raw: {} }
      }
      return post(thread, message)
    }
    return { slack: adapter }
  } }, storage)
  const emit = async (event: Record<string, unknown>, retry = 0, ackFails = false) => {
    sockets[0]!.emit("slack_event", { type: "events_api", body: { type: "event_callback", event, event_id: `event-${event.ts}`, team_id: "TEAM" }, retry_num: retry,
      ack: async () => { acks++; if (ackFails) throw new Error("synthetic ack failure") } })
    await new Promise<void>(resolve => setTimeout(resolve, 15))
  }
  const slash = async (command: string, channel = "CHANNEL", user = "1", text = "jarvis") => {
    sockets[0]!.emit("slack_event", { type: "slash_commands", body: { command, channel_id: channel, user_id: user, text, trigger_id: `synthetic-${posts.length}` }, ack: async () => { acks++ } })
    await new Promise<void>(resolve => setTimeout(resolve, 15))
  }
  const restore = async () => {
    await f.transport.stop()
    SocketModeClient.prototype.start = original.start
    SocketModeClient.prototype.disconnect = original.disconnect
    WebClient.prototype.apiCall = original.apiCall
  }
  return { ...f, sockets, posts, calls, files, emit, slash, restore, lifecycle: () => ({ disconnects, acks, downloads }) }
}

test("official Slack Socket Mode receives authorized DMs without Redis and deduplicates redelivery", async () => {
  const f = await fixture()
  try {
    await f.transport.start()
    assert.equal(f.sockets.length, 1)
    await f.emit({ type: "message", channel: "DM", channel_type: "im", user: "1", ts: "1", text: "!agent jarvis" })
    await eventually(() => f.posts.some(post => /Linked/.test(String(post.text))))
    await f.emit({ type: "message", channel: "DM", channel_type: "im", user: "2", ts: "2", text: "private", files: [{ url_private: "https://files.slack.com/synthetic", mimetype: "image/png" }] })
    assert.ok(f.posts.some(post => /access denied/i.test(String(post.text))))
    assert.equal(f.lifecycle().downloads, 0)
    const event = { type: "message", channel: "DM", channel_type: "im", user: "1", ts: "3", text: "hello" }
    await f.emit(event)
    await f.emit(event, 1)
    await f.emit({ ...event, user: "BOT", ts: "4" })
    await f.service.tick()
    assert.deepEqual(f.prompts.map(prompt => prompt.text), ["hello"])
    assert.equal(f.lifecycle().acks, 5)
  } finally { await f.restore() }
  assert.equal(f.lifecycle().disconnects, 1)
})

test("Slack channel-wide slash links and explicit thread links route through official adapters", async () => {
  const f = await fixture()
  try {
    await f.transport.start()
    await f.emit({ type: "message", channel: "OTHER", user: "1", ts: "1", text: "unrelated" })
    assert.equal(f.posts.length, 0)
    await f.slash("/agent")
    await eventually(() => f.posts.length > 0)
    assert.equal((await f.service.list())[0]!.conversations[0]!.id, "slack:CHANNEL:")
    await f.emit({ type: "app_mention", channel: "CHANNEL", user: "1", ts: "2", text: "<@BOT> !status" })
    assert.equal(f.prompts.length, 0)
    await f.emit({ type: "message", channel: "CHANNEL", user: "1", ts: "3", text: "channel prompt" })
    await f.emit({ type: "app_mention", channel: "THREAD", user: "1", ts: "4", text: "<@BOT> !agent jarvis" })
    await f.emit({ type: "message", channel: "THREAD", thread_ts: "4", user: "1", ts: "5", text: "thread prompt" })
    await f.emit({ type: "message", channel: "THREAD", user: "1", ts: "6", text: "different unlinked thread" })
    await f.service.tick()
    assert.deepEqual(f.prompts.map(prompt => prompt.text), ["channel prompt", "thread prompt"])
    assert.ok(f.posts.some(post => post.channel === "THREAD" && post.thread_ts === "4"))
  } finally { await f.restore() }
})

test("Slack acknowledgement failure does not reject the socket listener; retries stay deduplicated", async () => {
  const f = await fixture()
  try {
    await f.transport.start()
    await f.service.link("jarvis", "slack:DM:", "slack:1")
    const event = { type: "message", channel: "DM", channel_type: "im", user: "1", ts: "9", text: "recovered" }
    await f.emit(event, 0, true)
    await f.emit(event, 1)
    await f.service.tick()
    assert.deepEqual(f.prompts.map(prompt => prompt.text), ["recovered"])
  } finally { await f.restore() }
})

test("Slack owner-RPC links survive restart without SDK subscriptions and unlinks remain authoritative", async () => {
  const first = await fixture()
  await first.service.link("jarvis", "slack:CHANNEL:", "slack:1")
  await first.restore()
  const next = await fixture(false, first.storage)
  try {
    await next.transport.start()
    await next.emit({ type: "message", channel: "CHANNEL", user: "1", ts: "20", text: "owner linked" })
    await next.service.tick()
    assert.deepEqual(next.prompts.map(prompt => prompt.text), ["owner linked"])
    await next.slash("/unlink", "CHANNEL", "1", "")
    await next.emit({ type: "message", channel: "CHANNEL", user: "1", ts: "21", text: "after unlink" })
    await next.service.tick()
    assert.equal(next.prompts.length, 1)
  } finally { await next.restore() }
})

test("Slack explicit thread link wins over channel link; authorized attachments use the SDK downloader", async () => {
  const f = await fixture()
  try {
    await f.service.create({ id: "other", allowedUsers: ["slack:1"] })
    await f.service.link("jarvis", "slack:CHANNEL:", "slack:1")
    await f.service.link("other", "slack:CHANNEL:root", "slack:1")
    await f.transport.start()
    await f.emit({ type: "message", channel: "CHANNEL", thread_ts: "root", user: "1", ts: "31", text: "inspect", files: [{ url_private: "https://files.slack.com/synthetic", mimetype: "image/png", size: 15 }] })
    await eventually(async () => { await f.service.tick(); return f.prompts.length === 1 })
    assert.equal(f.lifecycle().downloads, 1)
    assert.equal(f.prompts[0]!.sessionID, (await f.service.get("other")).sessionID)
    await f.emit({ type: "message", channel: "CHANNEL", thread_ts: "root", user: "1", ts: "32", subtype: "message_changed", text: "edited" })
    await f.service.tick()
    assert.equal(f.prompts.length, 1)
  } finally { await f.restore() }
})

test("Slack shutdown drains SDK attachment handlers before disconnecting Chat state", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(false, fixtureStorage(), gate)
  try {
    await f.service.link("jarvis", "slack:DM:", "slack:1")
    await f.transport.start()
    await f.emit({ type: "message", channel: "DM", channel_type: "im", user: "1", ts: "40", text: "save before shutdown", files: [{ url_private: "https://files.slack.com/synthetic", mimetype: "image/png", size: 15 }] })
    await eventually(() => f.lifecycle().downloads === 1)
    let stopped = false
    const stopping = f.transport.stop().then(() => { stopped = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(stopped, false)
    release()
    await stopping
    await f.service.tick()
    assert.deepEqual(f.prompts.map(prompt => prompt.text), ["save before shutdown"])
  } finally { release(); await f.restore() }
})

test("Slack SDK outbox preserves channel/thread destinations and Unicode chunking with files", async () => {
  const f = await fixture()
  try {
    await f.transport.start()
    await writeFile(join(f.directory, "artifact.txt"), "synthetic artifact")
    const text = "😀".repeat(1801)
    await f.transport.post("slack:CHANNEL:root", text, await captureFile(f.directory, "artifact.txt"))
    assert.equal(f.files[0]!.thread, "slack:CHANNEL:root")
    const chunks = f.posts.map(post => String(post.text))
    assert.deepEqual(chunks.map(chunk => Array.from(chunk).length), [1800, 1])
    assert.equal(chunks.join(""), text)
    assert.ok(f.posts.every(post => post.channel === "CHANNEL" && post.thread_ts === "root"))
    await f.transport.post("slack:CHANNEL:", "literal *text* @someone <example>")
    assert.equal(f.posts.at(-1)!.text, "literal *text* @someone <example>")
    assert.equal(f.posts.at(-1)!.mrkdwn, false)
    await assert.rejects(f.transport.post("telegram:1", "wrong transport"), /disabled/)
  } finally { await f.restore() }
})

test("Slack startup failures clean up and never return raw credential errors", async () => {
  const f = await fixture(true)
  try {
    await assert.rejects(f.transport.start(), error => {
      assert.match(String(error), /Chat SDK setup failed/)
      assert.doesNotMatch(String(error), /synthetic secret/)
      return true
    })
    assert.ok(f.lifecycle().disconnects >= 1)
  } finally { await f.restore() }
})

test("Slack factory requires bot and app tokens, not signing secret or user token", () => {
  const [slack] = Object.values(createChatAdapters(["slack"], { SLACK_BOT_TOKEN: "synthetic", SLACK_APP_TOKEN: "synthetic" }))
  assert.equal((slack as ReturnType<typeof createSlackAdapter>).isSocketMode, true)
  assert.throws(() => createChatAdapters(["slack"], { SLACK_BOT_TOKEN: "synthetic" }), /SLACK_APP_TOKEN/)
})

test("Chat SDK logger emits fixed sanitized diagnostics, never SDK payloads", () => {
  const lines: string[] = []; const original = console.error
  console.error = value => { lines.push(String(value)) }
  try {
    const logger = chatLogger("slack")
    logger.info("Slack socket mode connected", { token: "TOP_SECRET" })
    logger.child("TOP_SECRET").warn("TOP_SECRET prompt", { error: new Error("TOP_SECRET") })
    logger.debug("TOP_SECRET", { text: "TOP_SECRET" })
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /slack.connected/)
    assert.doesNotMatch(lines.join(""), /TOP_SECRET/)
  } finally { console.error = original }
})
