import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Timers } from "../src/timers.js"
import { MemoryFiles } from "../src/files.js"
import { resetTime } from "../src/errors.js"

test("durable one-shot timers isolate Gods, cancel and retry failed admission", async () => {
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
test("shared memory is bounded and task files are God-specific", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octg-memory-")); const memory = new MemoryFiles(directory, 20)
  await memory.save("shared"); await memory.save("alice task", "alice"); await memory.save("bob task", "bob")
  assert.match(await memory.context("alice"), /shared/); assert.doesNotMatch(await memory.context("alice"), /bob task/)
  await assert.rejects(memory.save("x".repeat(21)), /budget/)
  assert.throws(() => memory.path("../bob"), /Invalid/)
})
test("only bounded future Retry-After values authorize recovery", () => {
  assert.equal(resetTime(new Headers({ "retry-after": "60" }), 1000), 61_000)
  assert.equal(resetTime(new Headers({ "retry-after": "garbage" }), 1000), undefined)
  assert.equal(resetTime(new Headers({ "retry-after": "999999999" }), 1000), undefined)
})
