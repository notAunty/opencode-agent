import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac, generateKeyPairSync, sign } from "node:crypto"
import { createSlackAdapter } from "@chat-adapter/slack"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { createDiscordAdapter } from "@chat-adapter/discord"

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
const request = (body: string, headers: Record<string, string> = {}) => new Request("https://fixture.invalid/chat", { method: "POST", body, headers: { "content-type": "application/json", ...headers } })

test("official Chat SDK adapters reject unauthenticated webhook requests without bot connections", async () => {
  const adapters = [
    createSlackAdapter({ mode: "webhook", botToken: "synthetic", signingSecret: "synthetic", logger }),
    createTelegramAdapter({ mode: "webhook", botToken: "1:synthetic", secretToken: "synthetic", userName: "synthetic", logger }),
    createDiscordAdapter({ botToken: "synthetic", applicationId: "synthetic", publicKey: "00".repeat(32), logger }),
  ]
  for (const adapter of adapters) assert.equal((await adapter.handleWebhook(request("{}"))).status, 401)
})

test("Slack challenge verification accepts only valid, current signatures", async () => {
  const adapter = createSlackAdapter({ mode: "webhook", botToken: "synthetic", signingSecret: "synthetic-secret", logger })
  const body = JSON.stringify({ type: "url_verification", challenge: "fixture-challenge" })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = (time: string) => `v0=${createHmac("sha256", "synthetic-secret").update(`v0:${time}:${body}`).digest("hex")}`
  const valid = await adapter.handleWebhook(request(body, { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature(timestamp) }))
  assert.equal(valid.status, 200)
  assert.match(await valid.text(), /fixture-challenge/)
  const old = String(Number(timestamp) - 600)
  assert.equal((await adapter.handleWebhook(request(body, { "x-slack-request-timestamp": old, "x-slack-signature": signature(old) }))).status, 401)
})

test("Telegram webhook verifies its secret before parsing an update", async () => {
  const adapter = createTelegramAdapter({ mode: "webhook", botToken: "1:synthetic", secretToken: "fixture-secret", userName: "synthetic", logger })
  assert.equal((await adapter.handleWebhook(request("{}", { "x-telegram-bot-api-secret-token": "wrong" }))).status, 401)
  assert.equal((await adapter.handleWebhook(request('{"update_id":1}', { "x-telegram-bot-api-secret-token": "fixture-secret" }))).status, 200)
})

test("Discord ping verifies Ed25519 signatures without starting Gateway", async () => {
  const keys = generateKeyPairSync("ed25519")
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex")
  const adapter = createDiscordAdapter({ botToken: "synthetic", applicationId: "synthetic", publicKey, logger })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = '{"type":1}'
  const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex")
  const result = await adapter.handleWebhook(request(body, { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }))
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { type: 1 })
  assert.equal((await adapter.handleWebhook(request('{"type":2}', { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }))).status, 401)
})
