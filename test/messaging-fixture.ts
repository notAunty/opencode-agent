import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ChatBridge, ChatRouter, type ChatRuntime, type ChatOptions } from "../src/chat.js"
import { AgentSessions } from "../src/service.js"
import { Timers } from "../src/timers.js"
import type { Json, Sessions, Storage } from "../src/contracts.js"

export const chatOptions = (platforms: ChatOptions["platforms"]): ChatOptions => ({
  enabled: true, host: "127.0.0.1", port: 8787, platforms, discordGateway: false,
})
export const fixtureStorage = (): Storage => {
  const values = new Map<string, Json>()
  return { get: async key => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)) } }
}
export async function messagingFixture(platform: "slack" | "telegram", runtime: ChatRuntime = {}, storage = fixtureStorage()) {
  const directory = await mkdtemp(join(tmpdir(), "octg-sdk-"))
  const prompts: { text: string; id: string; sessionID: string }[] = []
  const sessions: Sessions = { create: async input => ({ id: input.id }), get: async id => ({ id }),
    prompt: async input => { prompts.push(input) }, context: async () => [], compact: async () => {}, interrupt: async () => {} }
  // Outbound-only adapters must never resolve or bind the configured webhook listener.
  const transport = new ChatBridge({ ...chatOptions([platform]), host: "listener-must-not-open.invalid" }, {
    SLACK_BOT_TOKEN: "synthetic-bot", SLACK_APP_TOKEN: "synthetic-app", TELEGRAM_BOT_TOKEN: "100:synthetic",
  }, { storage, ...runtime })
  const service = new AgentSessions(storage, sessions, transport)
  if (!(await service.list()).some(agent => agent.id === "jarvis")) await service.create({ id: "jarvis", allowedUsers: [`${platform}:1`] })
  transport.attach(new ChatRouter(service, new Timers(join(directory, "timers.json")), directory))
  return { transport, service, prompts, storage, directory }
}
export async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error("Synthetic transport did not reach expected state")
}
