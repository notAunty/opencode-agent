import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SocketModeClient } from "@slack/socket-mode"
import type { WebClient } from "@slack/web-api"
import { SlackSocket } from "../src/slack.js"
import { ChatRouter } from "../src/chat.js"
import { AgentSessions } from "../src/service.js"
import { Timers } from "../src/timers.js"
import type { Json, Sessions } from "../src/contracts.js"

async function fixture() {
  const socket = new SocketModeClient({ appToken: "synthetic" })
  let starts = 0; let stops = 0; let acks = 0
  socket.start = async () => { starts++; return { ok: true } }
  socket.disconnect = async () => { stops++ }
  const posts: string[] = []
  const web = { auth: { test: async () => ({ ok: true, user_id: "BOT" }) },
    chat: { postMessage: async (payload: { text: string }) => { posts.push(payload.text); return { ok: true } } },
  } as unknown as WebClient
  const transport = new SlackSocket(socket, web, "synthetic")
  let state: Json | undefined
  const prompts: string[] = []
  const sessions: Sessions = { create: async input => ({ id: input.id }), get: async id => ({ id }),
    prompt: async input => { prompts.push(input.text) }, context: async () => [], compact: async () => {}, interrupt: async () => {} }
  const directory = await mkdtemp(join(tmpdir(), "octg-slack-"))
  const service = new AgentSessions({ get: async () => structuredClone(state), set: async (_, value) => { state = structuredClone(value) } }, sessions, transport)
  await service.create({ id: "jarvis", allowedUsers: ["slack:USER"] })
  transport.attach(new ChatRouter(service, new Timers(join(directory, "timers.json")), directory))
  const emit = async (type: string, event?: Record<string, unknown>, body = {}, ackFails = false) => {
    socket.emit(type, { event, body, ack: async () => { acks++; if (ackFails) throw new Error("synthetic ack failure") } })
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return { transport, service, emit, prompts, posts, lifecycle: () => ({ starts, stops, acks }) }
}
test("Slack Socket Mode links DMs, checks authorization and suppresses duplicate prompt admission", async () => {
  const f = await fixture()
  await f.transport.start()
  try {
    await f.emit("message", { type: "message", channel: "DM", channel_type: "im", user: "USER", ts: "1", text: "!agent jarvis" })
    assert.match(f.posts[0]!, /Linked to jarvis/)
    await f.emit("message", { type: "message", channel: "DM", channel_type: "im", user: "INTRUDER", ts: "2", text: "private", files: [{ url_private: "https://untrusted.invalid/file", mimetype: "image/png" }] })
    assert.ok(f.posts.some(text => /access denied/i.test(text)))
    for (let i = 0; i < 2; i++) await f.emit("message", { type: "message", channel: "DM", channel_type: "im", user: "USER", ts: "3", text: "hello" })
    await f.emit("message", { type: "message", channel: "DM", channel_type: "im", user: "BOT", ts: "4", text: "echo" })
    await f.service.tick()
    assert.deepEqual(f.prompts, ["hello"])
  } finally { await f.transport.stop() }
  assert.deepEqual(f.lifecycle(), { starts: 1, stops: 1, acks: 5 })
})

test("Slack acknowledgement failure does not discard a received message; redelivery stays deduplicated", async () => {
  const f = await fixture()
  await f.transport.start()
  try {
    await f.emit("message", { type: "message", channel: "DM", channel_type: "im", user: "USER", ts: "1", text: "!agent jarvis" })
    const event = { type: "message", channel: "DM", channel_type: "im", user: "USER", ts: "2", text: "keep this input" }
    await f.emit("message", event, {}, true)
    await f.emit("message", event)
    await f.service.tick()
    assert.deepEqual(f.prompts, ["keep this input"])
  } finally { await f.transport.stop() }
})
test("Slack socket slash commands bind channels without a webhook; unrelated channel messages are ignored", async () => {
  const f = await fixture()
  await f.transport.start()
  try {
    await f.emit("message", { type: "message", channel: "OTHER", user: "USER", ts: "1", text: "unrelated" })
    assert.equal(f.posts.length, 0)
    await f.emit("slash_commands", undefined, { command: "/agent", text: "jarvis", user_id: "USER", channel_id: "CHANNEL", trigger_id: "fixture" })
    assert.match(f.posts[0]!, /Linked to jarvis/)
    await f.emit("app_mention", { type: "app_mention", channel: "CHANNEL", user: "USER", ts: "2", text: "<@BOT> inspect" })
    await f.service.tick()
    assert.deepEqual(f.prompts, ["inspect"])
  } finally { await f.transport.stop() }
})
