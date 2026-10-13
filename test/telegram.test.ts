import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { createChatAdapters } from "../src/chat.js"
import { localChatState } from "../src/chat-state.js"
import { Messaging } from "../src/messaging.js"
import { chatCommands } from "../src/commands.js"
import { captureFile } from "../src/transfers.js"
import { messagingFixture, eventually, fixtureStorage, chatOptions } from "./messaging-fixture.js"

async function fixture(webhook = "", storage = fixtureStorage()) {
  const original = globalThis.fetch
  const calls: { method: string; payload: Record<string, unknown> }[] = []
  const queued: unknown[] = []
  let sent = 0; let update = 0
  const request: typeof fetch = async (url, init) => {
    const method = String(url).split("/").at(-1)!
    const payload = init?.body instanceof FormData ? Object.fromEntries(init.body.entries())
      : init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    calls.push({ method, payload })
    let result: unknown = true
    if (method === "getWebhookInfo") result = { url: webhook }
    else if (method === "getMe") result = { id: 100, is_bot: true, first_name: "Synthetic", username: "synthetic_bot" }
    else if (method === "getUpdates") {
      if (queued.length) result = queued.splice(0)
      else result = await new Promise<unknown[]>((resolve, reject) => {
        const timer = setTimeout(() => { init?.signal?.removeEventListener("abort", stop); resolve(queued.splice(0)) }, 10)
        const stop = () => { clearTimeout(timer); reject(new DOMException("synthetic abort", "AbortError")) }
        init?.signal?.addEventListener("abort", stop, { once: true })
        if (init?.signal?.aborted) stop()
      })
    } else if (method === "sendMessage" || method === "sendDocument") result = { message_id: ++sent, date: 1, text: payload.text ?? "", chat: { id: payload.chat_id, type: "private" } }
    else if (method === "getFile") result = { file_path: "synthetic.png" }
    else if (method === "synthetic.png") return new Response(Buffer.from("synthetic image"))
    else if (method !== "setMyCommands" && method !== "sendChatAction") throw new Error(`Unexpected synthetic Telegram method: ${method}`)
    return Response.json({ ok: true, result })
  }
  globalThis.fetch = request
  const f = await messagingFixture("telegram", { fetch: request }, storage)
  const message = (user: number, text: string, command = false, topic?: number, photo = false, id?: number) => {
    const messageID = id ?? ++update
    queued.push({ update_id: ++update, message: { message_id: messageID, date: 1,
      chat: { id: topic ? -10 : 1, type: topic ? "supergroup" : "private", first_name: "User" },
      from: { id: user, is_bot: false, first_name: "User" }, text,
      ...(topic ? { message_thread_id: topic } : {}),
      ...(photo ? { photo: [{ file_id: "synthetic-file", file_unique_id: "synthetic", width: 1, height: 1, file_size: 15 }] } : {}),
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
    } })
  }
  const restore = async () => { await f.transport.stop(); globalThis.fetch = original }
  return { ...f, calls, message, restore }
}

test("official Telegram polling registers commands and handles authorized DMs without Redis or webhook deletion", async () => {
  const f = await fixture()
  try {
    await f.transport.start()
    await eventually(() => f.calls.some(call => call.method === "getUpdates"))
    assert.deepEqual(f.calls.find(call => call.method === "setMyCommands")?.payload.commands, chatCommands)
    assert.deepEqual(f.calls.find(call => call.method === "getUpdates")?.payload.allowed_updates, ["message"])
    f.message(1, "/agent@synthetic_bot jarvis", true)
    await eventually(() => f.calls.some(call => call.method === "sendMessage" && /Linked/.test(String(call.payload.text))))
    f.message(2, "unauthorized", false, undefined, true)
    await eventually(() => f.calls.some(call => call.method === "sendMessage" && /access denied/i.test(String(call.payload.text))))
    assert.equal(f.calls.some(call => call.method === "getFile"), false)
    f.message(1, "hello", false, undefined, false, 50)
    f.message(1, "hello", false, undefined, false, 50)
    await eventually(async () => { await f.service.tick(); return f.prompts.length === 1 })
    assert.deepEqual(f.prompts.map(prompt => prompt.text), ["hello"])
    f.message(1, "/status", true)
    await eventually(() => f.calls.some(call => call.method === "sendMessage" && String(call.payload.text).startsWith("{")))
    assert.equal(f.calls.some(call => /deleteWebhook|setWebhook/.test(call.method)), false)
  } finally { await f.restore() }
})

test("Telegram SDK file output and Unicode notices preserve forum topic destinations", async () => {
  const f = await fixture()
  try {
    await f.transport.start()
    await writeFile(join(f.directory, "artifact.txt"), "synthetic artifact")
    const text = "😀".repeat(1801)
    await f.transport.post("telegram:-10:7", text, await captureFile(f.directory, "artifact.txt"))
    const upload = f.calls.find(call => call.method === "sendDocument")!
    assert.equal(String(upload.payload.chat_id), "-10")
    assert.equal(String(upload.payload.message_thread_id), "7")
    const chunks = f.calls.filter(call => call.method === "sendMessage").map(call => String(call.payload.text))
    assert.deepEqual(chunks.map(chunk => Array.from(chunk).length), [1800, 1])
    assert.equal(chunks.join(""), text)
  } finally { await f.restore() }
})

test("Telegram admission keys remain compatible with pre-migration inbox deduplication", async () => {
  const f = await fixture()
  try {
    await f.service.link("jarvis", "telegram:1", "telegram:1")
    await f.service.accept("jarvis", "already saved", "chat:telegram:1:77", "telegram:1")
    await f.transport.start()
    f.message(1, "already saved", false, undefined, false, 77)
    await eventually(async () => { await f.service.tick(); return f.prompts.length === 1 })
    await new Promise(resolve => setTimeout(resolve, 30))
    await f.service.tick()
    assert.deepEqual(f.prompts.map(prompt => prompt.text), ["already saved"])
  } finally { await f.restore() }
})

test("Telegram unknown slash commands retain ordinary prompt routing", async () => {
  const f = await fixture()
  try {
    await f.service.link("jarvis", "telegram:1", "telegram:1")
    await f.transport.start()
    f.message(1, "/unknown inspect", true)
    await eventually(async () => { await f.service.tick(); return f.prompts.length === 1 })
    assert.equal(f.prompts[0]!.text, "/unknown inspect")
  } finally { await f.restore() }
})

test("Telegram topic links and attachment downloads preserve authorization and topic IDs", async () => {
  const f = await fixture()
  try {
    await f.transport.start()
    f.message(1, "/agent jarvis", true, 7)
    await eventually(async () => (await f.service.list())[0]!.conversations.some(binding => binding.id === "telegram:-10:7"))
    f.message(1, "inspect image", false, 7, true)
    await eventually(async () => { await f.service.tick(); return f.prompts.length === 1 })
    assert.equal(f.calls.filter(call => call.method === "getFile").length, 1)
    assert.ok(f.calls.some(call => call.method === "sendMessage" && call.payload.message_thread_id === 7))
    f.message(2, "inspect image", false, 7, true)
    await eventually(() => f.calls.some(call => call.method === "sendMessage" && /access denied/i.test(String(call.payload.text))))
    assert.equal(f.calls.filter(call => call.method === "getFile").length, 1)
  } finally { await f.restore() }
})

test("polling refuses existing webhook before starting the SDK and without exposing credentials", async () => {
  const f = await fixture("https://existing.invalid/webhook")
  try {
    await assert.rejects(f.transport.start(), /remove any existing webhook manually/)
    assert.deepEqual(f.calls.map(call => call.method), ["getWebhookInfo"])
  } finally { await f.restore() }
})

test("local Chat state persists only Telegram polling checkpoints in native plugin storage", async () => {
  const storage = fixtureStorage()
  const first = localChatState(storage)
  await first.connect()
  await first.set("telegram:polling:synthetic", { offset: 42, pending: [{ update: { update_id: 41 } }] })
  await first.set("ephemeral", { secret: "synthetic" })
  await first.subscribe("slack:CHANNEL:1")
  await first.disconnect()
  const next = localChatState(storage)
  await next.connect()
  assert.deepEqual(await next.get("telegram:polling:synthetic"), { offset: 42, pending: [{ update: { update_id: 41 } }] })
  assert.equal(await next.get("ephemeral"), null)
  assert.equal(await next.isSubscribed("slack:CHANNEL:1"), false)
  await next.disconnect()
})

test("Telegram restores fetched pending updates from a durable checkpoint before polling", async () => {
  const storage = fixtureStorage()
  const scope = createHash("sha256").update("100").digest("hex")
  await storage.set(`chat:telegram:polling:${scope}`, { offset: 100, pending: [{ receivedAt: 1, update: { update_id: 99,
    message: { message_id: 88, date: 1, text: "pending after restart", chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "User" } },
  } }] })
  const f = await fixture("", storage)
  try {
    await f.service.link("jarvis", "telegram:1", "telegram:1")
    await f.transport.start()
    await eventually(async () => { await f.service.tick(); return f.prompts.length === 1 })
    assert.equal(f.prompts[0]!.text, "pending after restart")
    assert.ok(f.calls.some(call => call.method === "getUpdates" && call.payload.offset === 100))
  } finally { await f.restore() }
})

test("Telegram factory uses explicit polling and disabled messaging requires no credentials", async () => {
  const adapters = createChatAdapters(["telegram"], { TELEGRAM_BOT_TOKEN: "synthetic" })
  assert.ok(adapters.telegram)
  assert.equal((adapters.telegram as ReturnType<typeof createTelegramAdapter>).isPolling, false)
  const messaging = new Messaging({ ...chatOptions(["telegram"]), enabled: false }, {})
  await messaging.start()
  await assert.rejects(messaging.post("telegram:1", "hello"), /disabled/)
  await messaging.stop()
})
