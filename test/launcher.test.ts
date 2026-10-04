import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

test("laptop launcher passes current-directory env and arguments to a child without starting OpenCode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octg-launcher-"))
  await mkdir(join(directory, "bin"))
  await writeFile(join(directory, ".env"), "SYNTHETIC_CREDENTIAL=file\nEXISTING=file\n")
  await writeFile(join(directory, "bin", "opencode"), '#!/usr/bin/env node\nconsole.log(JSON.stringify({credential:process.env.SYNTHETIC_CREDENTIAL,existing:process.env.EXISTING,args:process.argv.slice(2)}))\n', { mode: 0o700 })
  const { stdout } = await promisify(execFile)(process.execPath, [resolve("scripts/opencode-env.mjs"), "--standalone"], {
    cwd: directory, env: { PATH: `${join(directory, "bin")}:${process.env.PATH}`, EXISTING: "inherited" },
  })
  assert.deepEqual(JSON.parse(stdout), { credential: "file", existing: "inherited", args: ["--standalone"] })
})
