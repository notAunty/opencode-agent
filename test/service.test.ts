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
  return { make, prompts, replies, messages, created, sessions, messenger, fail: (value: boolean) => { failed = value }, failSession: (id: string) => { failedSession = id }, advance: (ms: number) => { now += ms } }
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

test("slow outbound delivery does not block durable staging or native admission", { timeout: 2000 }, async () => {
  const f = fixture(); const service = f.make()
  await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  await service.link("alice", "telegram:chat", "telegram:1")
  let release!: () => void; let started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const delivering = new Promise<void>(resolve => { started = resolve })
  f.messenger.post = async () => { started(); await blocked }
  await service.sendFile("alice", { uri: "file:///synthetic.png" }, "outbound")
  const tick = service.tick()
  try {
    await delivering
    await service.accept("alice", "new input", "new", "telegram:1")
    await service.admit()
    assert.equal(f.prompts.length, 1)
    assert.deepEqual((await service.status("alice")).pending, [])
  } finally { release(); await tick }
})

test("native admission permits concurrent staging and hooks without overwriting state", { timeout: 2000 }, async () => {
  const f = fixture(); const service = f.make()
  await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  let release!: () => void; let started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const admitting = new Promise<void>(resolve => { started = resolve })
  f.sessions.prompt = async input => { await service.localActivity(input.sessionID); started(); await blocked; f.prompts.push(input) }
  await service.accept("alice", "first", "first", "telegram:1")
  const tick = service.tick()
  try {
    await admitting
    await service.accept("alice", "second", "second", "telegram:1")
    assert.equal((await service.status("alice")).pending.length, 2)
  } finally { release(); await tick }
  assert.equal((await service.status("alice")).pending.length, 1)
  await service.tick()
  assert.equal(f.prompts.length, 2)
})

test("uncertain admission retries the same native ID without replaying a queued message", async () => {
  const f = fixture(); const service = f.make()
  await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  const queued = new Set<string>(); const attempts: string[] = []
  f.sessions.prompt = async input => {
    attempts.push(input.id)
    if (queued.has(input.id)) return
    queued.add(input.id)
    throw new DOMException("synthetic timeout after admission", "TimeoutError")
  }
  const saved = await service.accept("alice", "already queued", "same", "telegram:1")
  await service.tick()
  assert.equal((await service.status("alice")).pending.length, 1)
  f.advance(60_000); await service.tick()
  assert.deepEqual(attempts, [saved.id, saved.id])
  assert.equal(queued.size, 1)
  assert.equal((await service.accept("alice", "redelivery", "same", "telegram:1")).duplicate, true)
  assert.equal((await service.status("alice")).pending.length, 0)
})

test("diagnostics distinguish queue admission, context observation and assistant completion", async () => {
  const f = fixture(); const service = f.make()
  await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  const lines: string[] = []; const original = console.error
  console.error = line => { lines.push(String(line)) }
  try {
    const saved = await service.accept("alice", "private input text", "diagnostic", "telegram:1")
    await service.tick()
    assert.ok(lines.some(line => JSON.parse(line).stage === "native.admitted"))
    assert.ok(!lines.some(line => JSON.parse(line).stage === "native.assistant.completed"))
    f.messages.push({ id: saved.id, type: "user", time: { created: 1001 } })
    f.messages.push({ id: "reply", type: "assistant", time: { created: 1001, completed: 1002 }, finish: "stop" })
    await service.reconcile(); await service.reconcile()
    const stages = lines.map(line => JSON.parse(line).stage)
    assert.equal(stages.filter(stage => stage === "native.context.observed").length, 1)
    assert.equal(stages.filter(stage => stage === "native.assistant.completed").length, 1)
    assert.doesNotMatch(lines.join("\n"), /private input text/)
  } finally { console.error = original }
})

test("native context confirms an uncertain admission without replay", async () => {
  const f = fixture(); const service = f.make()
  await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  const saved = await service.accept("alice", "queued", "confirmed", "telegram:1")
  f.fail(true); await service.tick()
  f.messages.push({ id: saved.id, type: "user", time: { created: 1001 } })
  await service.reconcile()
  assert.equal((await service.status("alice")).pending.length, 0)
  f.fail(false); f.advance(60_000); await service.tick()
  assert.equal(f.prompts.length, 0)
  assert.equal((await service.accept("alice", "redelivery", "confirmed", "telegram:1")).duplicate, true)
})
