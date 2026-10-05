import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Timers } from "../src/timers.js"
import { MemoryFiles } from "../src/files.js"
import { resetTime } from "../src/errors.js"

test("durable one-shot timers isolate Agent Sessions, cancel and retry failed admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octg-")); const path = join(directory, "timers.json")
  let now = 1000
  let timers = new Timers(path, () => now)
  const a = await timers.create("alice", "wake", { delayMs: 1000 })
  const b = await timers.create("bob", "cancelled", { at: "2026-01-01T00:00:00Z" })
  assert.equal(await timers.cancel("alice", b.id), false)
  assert.equal(await timers.cancel("bob", b.id), true)
  await assert.rejects(timers.create("alice", "bad", { at: "2026-01-01T00:00:00" }), /timezone/)
  now = 2000; await assert.rejects(timers.tick(async () => { throw new Error("offline") }))
  timers = new Timers(path, () => now)
  const ids: string[] = []
  await timers.tick(async timer => { ids.push(timer.id) }); await timers.tick(async timer => { ids.push(timer.id) })
  assert.deepEqual(ids, [a.id]); assert.equal((await timers.list("alice")).length, 0)
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1)
})
test("native file edits update bounded memory and session-specific task indexes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octg-memory-")); const memory = new MemoryFiles(directory, 20)
  await mkdir(join(directory, "TASKS"))
  await writeFile(join(directory, "MEMORY.md"), "shared")
  await writeFile(join(directory, "TASKS", "alice.md"), "261003-alice-task.md")
  await writeFile(join(directory, "TASKS", "bob.md"), "bob task")
  await writeFile(join(directory, "TASKS", "261003-alice-task.md"), "task details loaded only on demand")
  const context = await memory.context("alice")
  assert.match(context, /shared/); assert.match(context, /261003-alice-task.md/)
  assert.doesNotMatch(context, /bob task|task details loaded only on demand/)
  await writeFile(join(directory, "MEMORY.md"), "x".repeat(21))
  assert.match(await memory.context("alice"), /x{20}\n\[Memory truncated/)
  await assert.rejects(memory.context("../bob"), /Invalid/)
  const unsafe = await mkdtemp(join(tmpdir(), "octg-memory-symlink-"))
  await symlink(directory, join(unsafe, "TASKS"))
  await assert.rejects(new MemoryFiles(unsafe).context("alice"), /symlink/)
})
test("only bounded future Retry-After values authorize recovery", () => {
  assert.equal(resetTime(new Headers({ "retry-after": "60" }), 1000), 61_000)
  assert.equal(resetTime(new Headers({ "retry-after": "garbage" }), 1000), undefined)
  assert.equal(resetTime(new Headers({ "retry-after": "999999999" }), 1000), undefined)
})
test("a failed timer does not starve other Agent Session timers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octg-timer-isolation-"))
  const timers = new Timers(join(directory, "timers.json"), () => 1000)
  await timers.create("alice", "offline", { delayMs: 0 })
  await timers.create("bob", "online", { delayMs: 0 })
  const admitted: string[] = []
  await assert.rejects(timers.tick(async timer => {
    if (timer.agentId === "alice") throw new Error("offline")
    admitted.push(timer.agentId)
  }), AggregateError)
  assert.deepEqual(admitted, ["bob"])
  assert.equal((await timers.list("alice")).length, 1)
  assert.equal((await timers.list("bob")).length, 0)
})
