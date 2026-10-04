import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { OpenCode } from "@opencode/sdk"
import plugin from "../src/index.js"
import { Octg } from "../src/rpc.js"

const directory = "/app/native-fixture"
await mkdir(directory, { recursive: true })
const example = JSON.parse((await readFile("examples/opencode.jsonc", "utf8")))
delete example.plugins
await writeFile(join(directory, "opencode.json"), JSON.stringify(example))
const start = () => OpenCode.create({ plugins: [plugin], models: { fetch: false }, fs: { filewatcher: false, fff: false },
  database: { path: join(directory, "state.sqlite") },
  config: { project: false, content: JSON.stringify(example) },
  log: { level: "error", emit: () => {} } })
let host = await start()
try {
  const owner = host.rpc(Octg)
  const request = { location: { directory }, signal: AbortSignal.timeout(30_000) }
  const alice = await owner.create({ id: "alice", allowedUsers: ["telegram:1"] }, request)
  const bob = await owner.create({ id: "bob", allowedUsers: ["telegram:2"] }, request)
  assert.notEqual(alice.sessionID, bob.sessionID)
  const session = await host.sessions.get({ sessionID: alice.sessionID as never }, request)
  assert.equal(session.location.directory, directory)
  assert.equal(session.agent, "main")
  await owner.link({ agentId: "alice", conversation: "telegram:synthetic", user: "telegram:1" }, request)
  await assert.rejects(owner.link({ agentId: "bob", conversation: "telegram:synthetic", user: "telegram:1" }, request))
  const timer = await owner.timer({ agentId: "alice", prompt: "synthetic future wake", delayMs: 3_600_000 }, request)
  assert.equal((await owner.timers({ agentId: "alice" }, request)).length, 1)
  assert.equal(await owner.cancelTimer({ agentId: "bob", timerId: timer.id }, request), false)
  assert.equal(await owner.cancelTimer({ agentId: "alice", timerId: timer.id }, request), true)
  assert.equal((await owner.list(undefined, request)).length, 2)
  const durable = await owner.timer({ agentId: "bob", prompt: "survive restart", delayMs: 3_600_000 }, request)
  await host.close()
  host = await start()
  const restored = host.rpc(Octg)
  const afterRestart = { location: { directory }, signal: AbortSignal.timeout(30_000) }
  const registry = await restored.list(undefined, afterRestart)
  assert.equal(registry.length, 2)
  assert.equal(registry.find((agent: { id: string }) => agent.id === "alice")?.sessionID, alice.sessionID)
  assert.equal((await restored.timers({ agentId: "bob" }, afterRestart))[0]?.id, durable.id)
  assert.equal(await restored.cancelTimer({ agentId: "bob", timerId: durable.id }, afterRestart), true)
  console.log("Native OpenCode V2 SDK: plugin lifecycle, RPC, sessions, authorization, storage and timer restart passed")
} finally { await host.close() }
