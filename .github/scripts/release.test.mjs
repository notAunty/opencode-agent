import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { needsPublication, nextPatch } from './release.mjs'

test('patch bump considers source and all stable published versions, not latest dist-tag', () => {
  assert.equal(nextPatch('2.0.2', ['2.0.1', '2.0.9', '2.0.3', '3.0.0-beta.1']), '2.0.10')
  assert.equal(nextPatch('2.1.0', ['2.0.9']), '2.1.1')
  assert.equal(nextPatch('2.0.0', ['2.1.3']), '2.1.4')
  assert.throws(() => nextPatch('2.0.0-beta.1', []), /stable version/)
})

test('only unpublished versions or published versions from identical source can proceed', () => {
  assert.equal(needsPublication('2.0.3', ['2.0.2'], null, 'source'), true)
  assert.equal(needsPublication('2.0.3', ['2.0.3'], 'source', 'source'), false)
  assert.throws(() => needsPublication('2.0.3', ['2.0.3'], 'other', 'source'), /different source/)
  assert.throws(() => needsPublication('2.0.3', ['2.0.3'], null, 'source'), /different source/)
})

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'release-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@fixture/package', version: '2.0.2' }))
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ version: '2.0.2', packages: { '': { version: '2.0.2' } } }))
  await writeFile(join(directory, 'state.json'), JSON.stringify({
    subject: 'fix: input', sha: 'source', versions: ['2.0.2'], gitHead: null, existingTag: '', ...overrides,
  }))
  const mock = `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync('state.json'));
const tool = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify([tool, ...args]) + '\\n');
if (tool === 'npm' && args[0] === 'view') {
  console.log(JSON.stringify(args[2] === 'versions' ? state.versions : state.gitHead));
} else if (tool === 'npm' && args[0] === 'version') {
  for (const path of ['package.json', 'package-lock.json']) {
    const doc = JSON.parse(fs.readFileSync(path)); doc.version = args[1];
    if (doc.packages) doc.packages[''].version = args[1];
    fs.writeFileSync(path, JSON.stringify(doc));
  }
} else if (tool === 'git') {
  if (args[0] === 'log') console.log(state.subject);
  if (args[0] === 'rev-parse') console.log(state.sha);
  if (args[0] === 'ls-remote') console.log(state.existingTag);
  if (args[0] === 'commit') { state.sha = 'release-source'; state.subject = args[2]; }
  if (args[0] === 'push' && state.pushFails) process.exit(1);
  fs.writeFileSync('state.json', JSON.stringify(state));
} else process.exit(1);
`
  for (const tool of ['git', 'npm']) await writeFile(join(bin, tool), mock, { mode: 0o755 })
  const execute = (action, extraEnv = {}) => spawnSync(process.execPath, [fileURLToPath(new URL('./release.mjs', import.meta.url)), action], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: join(directory, 'output'), ...extraEnv },
  })
  return {
    execute,
    json: async path => JSON.parse(await readFile(join(directory, path), 'utf8')),
    output: () => readFile(join(directory, 'output'), 'utf8'),
    calls: async () => (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse),
  }
}

test('ordinary main push commits both manifests before publication can begin', async t => {
  const f = await fixture(t)
  const result = f.execute('prepare')
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await f.json('package.json')).version, '2.0.3')
  assert.equal((await f.json('package-lock.json')).packages[''].version, '2.0.3')
  assert.equal(await f.output(), 'version=2.0.3\nsha=release-source\npublish=true\n')
  assert.ok((await f.calls()).some(call => JSON.stringify(call) === JSON.stringify(['git', 'add', 'package.json', 'package-lock.json'])))
  assert.ok((await f.calls()).some(call => call[0] === 'git' && call[1] === 'push' && call[3] === 'HEAD:refs/heads/main'))
})

test('release commit keeps committed version and published rerun skips publication', async t => {
  const f = await fixture(t, { subject: 'release: 2.0.2', gitHead: 'source' })
  const result = f.execute('prepare')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await f.output(), 'version=2.0.2\nsha=source\npublish=false\n')
  assert.ok(!(await f.calls()).some(call => ['commit', 'push', 'version'].includes(call[1])))
})

test('unpublished manual release builds its exact version without bumping', async t => {
  const f = await fixture(t, { subject: 'release: 2.0.2', versions: ['2.0.1'] })
  const result = f.execute('prepare')
  assert.equal(result.status, 0, result.stderr)
  assert.match(await f.output(), /publish=true/)
  assert.equal((await f.json('package.json')).version, '2.0.2')
})

test('rejected reconciliation push aborts before exposing publish outputs', async t => {
  const f = await fixture(t, { pushFails: true })
  assert.notEqual(f.execute('prepare').status, 0)
  await assert.rejects(f.output(), { code: 'ENOENT' })
})

test('tagging verifies published source and never overwrites conflicting tags', async t => {
  const good = await fixture(t, { gitHead: 'source' })
  const env = { RELEASE_VERSION: '2.0.2', RELEASE_SHA: 'source' }
  assert.equal(good.execute('tag', env).status, 0)
  assert.ok((await good.calls()).some(call => call[1] === 'tag' && call[2] === 'v2.0.2' && call[3] === 'source'))
  const conflict = await fixture(t, { gitHead: 'source', existingTag: 'other\trefs/tags/v2.0.2' })
  assert.notEqual(conflict.execute('tag', env).status, 0)
  assert.ok(!(await conflict.calls()).some(call => call[1] === 'push'))
  const wrongSource = await fixture(t, { gitHead: 'other' })
  assert.notEqual(wrongSource.execute('tag', env).status, 0)
  assert.ok(!(await wrongSource.calls()).some(call => call[1] === 'tag'))
})
