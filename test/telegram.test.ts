import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Telegraf } from "telegraf"
import { TelegramPolling } from "../src/telegram.js"
import { Messaging } from "../src/messaging.js"
import { ChatRouter } from "../src/chat.js"
import { AgentSessions } from "../src/service.js"
import { Timers } from "../src/timers.js"
import type { Json, Sessions } from "../src/contracts.js"
import { chatCommands } from "../src/commands.js"

async function fixture(webhook = "") {
  const bot = new Telegraf("synthetic-token")
  const calls: { method: string; payload: Record<string, unknown> }[] = []
  bot.telegram.callApi = (async (method: string, payload: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    calls.push({ method, payload })
    if (method === "getWebhookInfo") return { url: webhook }
    if (method === "getMe") return { id: 100, is_bot: true, first_name: "Synthetic", username: "synthetic_bot" }
    if (method === "getUpdates") return new Promise((_, reject) => {
      const stop = () => reject(new Error("aborted"))
      options?.signal?.addEventListener("abort", stop, { once: true })
      if (options?.signal?.aborted) stop()
    })
    return true
  }) as typeof bot.telegram.callApi
  const transport = new TelegramPolling(bot)
  let state: Json | undefined
  const prompts: string[] = []
  const sessions: Sessions = { create: async input => ({ id: input.id }), get: async id => ({ id }),
    prompt: async input => { prompts.push(input.text) }, context: async () => [], compact: async () => {}, interrupt: async () => {} }
  const directory = await mkdtemp(join(tmpdir(), "octg-telegram-"))
  const service = new AgentSessions({ get: async () => structuredClone(state), set: async (_, value) => { state = structuredClone(value) } }, sessions, transport)
  await service.create({ id: "jarvis", allowedUsers: ["telegram:1"] })
  transport.attach(new ChatRouter(service, new Timers(join(directory, "timers.json")), directory))
  let update = 0
  const message = (user: number, text: string, command = false) => bot.handleUpdate({ update_id: ++update,
    message: { message_id: update, date: 1, chat: { id: 1, type: "private", first_name: "User" },
      from: { id: user, is_bot: false, first_name: "User" }, text,
      ...(command ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }] } : {}),
    } })
  return { bot, calls, transport, service, prompts, message }
}
test("Telegraf polling registers commands and shares authorized DM routing without Redis or webhook deletion", async () => {
  const f = await fixture()
  await f.transport.start()
  try {
    assert.deepEqual(f.calls.find(call => call.method === "setMyCommands")?.payload.commands, chatCommands)
    assert.ok(f.calls.some(call => call.method === "getUpdates"))
    await f.message(1, "/agent@synthetic_bot jarvis", true)
    assert.ok(f.calls.some(call => call.method === "sendMessage" && String(call.payload.text).startsWith("Linked to jarvis")))
    await f.message(2, "unauthorized")
    await f.bot.handleUpdate({ update_id: 100, message: { message_id: 100, date: 1,
      chat: { id: 1, type: "private", first_name: "User" }, from: { id: 2, is_bot: false, first_name: "User" },
      photo: [{ file_id: "synthetic-file", file_unique_id: "synthetic", width: 1, height: 1 }],
    } })
    assert.equal(f.calls.some(call => call.method === "getFile"), false)
    await f.message(1, "hello")
    await f.service.tick()
    assert.deepEqual(f.prompts, ["hello"])
    await f.message(1, "/status", true)
    assert.equal(f.prompts.length, 1)
    assert.equal(f.calls.some(call => /deleteWebhook|setWebhook/.test(call.method)), false)
  } finally { await f.transport.stop() }
})
test("polling refuses existing webhook without changing it or exposing credentials", async () => {
  const f = await fixture("https://existing.invalid/webhook")
  await assert.rejects(f.transport.start(), /remove any existing webhook manually/)
  assert.deepEqual(f.calls.map(call => call.method), ["getWebhookInfo"])
  await f.transport.stop()
})
test("disabled messaging does not initialize polling or require credentials", async () => {
  const messaging = new Messaging({ enabled: false, host: "127.0.0.1", port: 8787, platforms: ["telegram"], discordGateway: false }, {})
  await messaging.start()
  await assert.rejects(messaging.post("telegram:1", "hello"), /disabled/)
  await messaging.stop()
})
