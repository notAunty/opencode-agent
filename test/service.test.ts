import { test } from "node:test"
import assert from "node:assert/strict"
import { AgentSessions } from "../src/service.js"
import type { Json, NativeMessage, Sessions, Storage } from "../src/contracts.js"

function fixture() {
  const values = new Map<string, unknown>()
  const storage: Storage = { get: async key => structuredClone(values.get(key)), set: async (key, value: Json) => { values.set(key, structuredClone(value)) } }
  const prompts: unknown[] = []; const replies: unknown[] = []; const created = new Map<string, { id: string; parentID?: string }>()
  const messages: NativeMessage[] = []
  let failed = false; let failedSession: string | undefined; let now = 1000
  const sessions: Sessions = {
    get: async id => { const value = created.get(id); if (!value) throw new Error("missing"); return value },
    create: async input => { created.set(input.id, { id: input.id }); return { id: input.id } },
    prompt: async input => { if (failed || input.sessionID === failedSession) throw new Error("offline"); prompts.push(input) },
    context: async () => messages, compact: async () => {}, interrupt: async () => {},
  }
  const messenger = { post: async (conversation: string, text: string) => { replies.push({ conversation, text }) } }
  const make = (namespace = "octg") => new AgentSessions(storage, sessions, messenger, () => now, true, namespace)
  return { make, prompts, replies, messages, created, fail: (value: boolean) => { failed = value }, failSession: (id: string) => { failedSession = id }, advance: (ms: number) => { now += ms } }
}

test("each Agent Session has its own authorization and linked native session", async () => {
  const f = fixture(); const service = f.make()
  const a = await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  const b = await service.create({ id: "bob", allowedUsers: ["telegram:2"] })
  assert.notEqual(a.sessionID, b.sessionID)
  await assert.rejects(service.link("bob", "telegram:chat", "telegram:1"), /access denied/)
  await service.link("alice", "telegram:chat", "telegram:1")
  await assert.rejects(service.byConversation("telegram:chat", "telegram:2"), /access denied/)
  await assert.rejects(service.link("bob", "telegram:chat", "telegram:2"), /access denied/)
})
test("native session and message admission IDs are isolated across projects", async () => {
  const a = fixture(); const b = fixture()
  const first = a.make("project-a"); const second = b.make("project-b")
  const sessionA = await first.create({ id: "alice", allowedUsers: ["telegram:1"] })
  const sessionB = await second.create({ id: "alice", allowedUsers: ["telegram:1"] })
  assert.notEqual(sessionA.sessionID, sessionB.sessionID)
  await first.accept("alice", "hello", "same"); await second.accept("alice", "hello", "same")
  await first.admitTimer("alice", "same-timer", "wake"); await second.admitTimer("alice", "same-timer", "wake")
  await first.tick(); await second.tick()
  const id = (prompt: unknown) => (prompt as { id: string }).id
  assert.notEqual(id(a.prompts[0]), id(b.prompts[0]))
  assert.notEqual(id(a.prompts[1]), id(b.prompts[1]))
})
test("a native child task cannot be registered as a primary Agent Session", async () => {
  const f = fixture()
  f.created.set("ses_child", { id: "ses_child", parentID: "ses_parent" })
  await assert.rejects(f.make().create({ id: "child", allowedUsers: ["telegram:1"], sessionID: "ses_child" }), /primary native session/)
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
test("recovery waits for a fresh reset error instead of waking a busy agent repeatedly", async () => {
  const f = fixture(); const service = f.make()
  const god = await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  await service.failure(god.sessionID, 429, undefined, 2000)
  f.advance(2000); await service.tick()
  f.advance(900_000); await service.tick(); assert.equal(f.prompts.length, 1)
  await service.failure(god.sessionID, 429, undefined, 1_000_000)
  f.advance(900_000); await service.tick(); assert.equal(f.prompts.length, 2)
  await service.failure(god.sessionID, 429, undefined, 2_000_000)
  f.advance(900_000); await service.tick(); assert.equal(f.prompts.length, 3)
  await service.failure(god.sessionID, 429, undefined, 3_000_000)
  f.advance(900_000); await service.tick(); assert.equal(f.prompts.length, 3)
})
test("failed Agent Session admission does not block others; revoked file notices are dropped", async () => {
  const f = fixture(); const service = f.make()
  const alice = await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  await service.create({ id: "bob", allowedUsers: ["telegram:2"] })
  await service.link("alice", "telegram:chat", "telegram:1")
  await service.sendFile("alice", { uri: "file:///synthetic.png", mime: "image/png" }, "screenshot")
  await service.setAllowlist("alice", ["telegram:3"])
  await service.tick(); assert.equal(f.replies.length, 0)
  f.failSession(alice.sessionID)
  await service.accept("alice", "first", "a"); await service.accept("bob", "second", "b")
  await service.tick(); assert.equal(f.prompts.length, 1)
  assert.match(JSON.stringify(f.prompts), /second/)
})
