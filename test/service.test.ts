import { test } from "node:test"
import assert from "node:assert/strict"
import { GodService } from "../src/service.js"
import type { Json, NativeMessage, Sessions, Storage } from "../src/contracts.js"

function fixture() {
  const values = new Map<string, unknown>()
  const storage: Storage = { get: async key => structuredClone(values.get(key)), set: async (key, value: Json) => { values.set(key, structuredClone(value)) } }
  const prompts: unknown[] = []; const replies: unknown[] = []; const created = new Map<string, { id: string }>()
  const messages: NativeMessage[] = []
  let failed = false; let now = 1000
  const sessions: Sessions = {
    get: async id => { const value = created.get(id); if (!value) throw new Error("missing"); return value },
    create: async input => { created.set(input.id, { id: input.id }); return { id: input.id } },
    prompt: async input => { if (failed) throw new Error("offline"); prompts.push(input) },
    context: async () => messages, compact: async () => {}, interrupt: async () => {},
  }
  const messenger = { post: async (conversation: string, text: string) => { replies.push({ conversation, text }) } }
  const make = () => new GodService(storage, sessions, messenger, () => now, true)
  return { make, prompts, replies, messages, created, fail: (value: boolean) => { failed = value }, advance: (ms: number) => { now += ms } }
}

test("each God has its own authorization and linked native session", async () => {
  const f = fixture(); const service = f.make()
  const a = await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  const b = await service.create({ id: "bob", allowedUsers: ["telegram:2"] })
  assert.notEqual(a.sessionID, b.sessionID)
  await assert.rejects(service.link("bob", "telegram:chat", "telegram:1"), /access denied/)
  await service.link("alice", "telegram:chat", "telegram:1")
  await assert.rejects(service.byConversation("telegram:chat", "telegram:2"), /access denied/)
  await assert.rejects(service.link("bob", "telegram:chat", "telegram:2"), /access denied/)
})
test("staged input survives restart, deduplicates and checks revocation", async () => {
  const f = fixture(); let service = f.make()
  await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  await service.accept("alice", "hello", "same", "telegram:1")
  await service.accept("alice", "hello", "same", "telegram:1")
  f.fail(true); await service.tick(); assert.equal(f.prompts.length, 0)
  service = f.make(); f.fail(false); f.advance(60_000); await service.tick()
  assert.equal(f.prompts.length, 1)
  await service.accept("alice", "hello", "same", "telegram:1"); await service.tick()
  assert.equal(f.prompts.length, 1)
  await service.accept("alice", "revoked", "new", "telegram:1")
  await service.setAllowlist("alice", ["telegram:2"]); await service.tick()
  assert.equal(f.prompts.length, 1)
})
test("replies and provider errors reach Chat once after reconciliation", async () => {
  const f = fixture(); const service = f.make()
  const god = await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  await service.link("alice", "telegram:chat", "telegram:1")
  f.messages.push({ id: "reply", type: "assistant", time: { created: 1001, completed: 1002 }, finish: "stop", content: [{ type: "text", text: "hello" }] })
  await service.reconcile(); await service.tick(); await service.reconcile(); await service.tick()
  assert.equal(f.replies.length, 1)
  await service.failure(god.sessionID, 401); await service.failure(god.sessionID, 401); await service.tick()
  assert.equal(f.replies.length, 2)
  assert.match(JSON.stringify(f.replies), /credentials/)
  assert.doesNotMatch(JSON.stringify(f.replies), /secret|stack|token/)
})
test("explicit reset recovery is bounded and cancelled by new user input", async () => {
  const f = fixture(); const service = f.make()
  const god = await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  await service.failure(god.sessionID, 429, undefined, 2000)
  f.advance(2000); await service.tick(); assert.equal(f.prompts.length, 1)
  await service.accept("alice", "new work", "user", "telegram:1"); await service.tick()
  f.advance(900_000); await service.tick(); assert.equal(f.prompts.length, 2)
})
