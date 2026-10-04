import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { environment } from "../src/environment.js"

test("project env files parse without shell execution or global mutation; inherited variables win", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octg-env-"))
  await writeFile(join(directory, ".env"), 'export OCTG_SYNTHETIC="quoted value"\nEXISTING=file\nLITERAL=$(touch never)\n')
  const env = await environment(directory, ".env", { EXISTING: "parent" })
  assert.equal(env.OCTG_SYNTHETIC, "quoted value")
  assert.equal(env.EXISTING, "parent")
  assert.equal(env.LITERAL, "$(touch never)")
  assert.equal(process.env.OCTG_SYNTHETIC, undefined)
  assert.deepEqual(await environment(directory, "missing", { EXISTING: "parent" }), { EXISTING: "parent" })
})
test("env loading is opt-in, project scoped, and rejects symlinks and oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octg-env-"))
  await writeFile(join(directory, ".env"), "PRIVATE=synthetic")
  assert.deepEqual(await environment(directory, undefined, {}), {})
  await assert.rejects(environment(directory, "../outside", {}), /remain in the project/)
  await symlink(join(directory, ".env"), join(directory, "linked"))
  await assert.rejects(environment(directory, "linked", {}), /symlink/)
  await writeFile(join(directory, "large"), "x".repeat(65537))
  await assert.rejects(environment(directory, "large", {}), /64 KiB/)
})
