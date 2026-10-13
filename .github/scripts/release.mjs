import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const registry = 'https://npm.pkg.github.com'
const run = (command, ...args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const manifest = () => JSON.parse(readFileSync('package.json', 'utf8'))
const view = (name, field) => JSON.parse(run('npm', 'view', name, field, '--json', `--registry=${registry}`) || 'null')

export function nextPatch(current, published) {
  const parse = value => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Expected stable version: ${value}`)
    return value.split('.').map(Number)
  }
  let highest = parse(current)
  for (const version of published) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue
    const candidate = parse(version)
    for (let i = 0; i < 3; i++) {
      if (candidate[i] > highest[i]) { highest = candidate; break }
      if (candidate[i] < highest[i]) break
    }
  }
  highest[2]++
  return highest.join('.')
}

export function needsPublication(version, versions, gitHead, sha) {
  if (!versions.includes(version)) return true
  if (gitHead !== sha) throw new Error(`Version ${version} already belongs to a different source commit`)
  return false
}

function prepare() {
  const { name, version } = manifest()
  const result = view(name, 'versions')
  if (!result) throw new Error('Cannot read published versions; check package Actions access')
  const versions = Array.isArray(result) ? result : [result]
  const subject = run('git', 'log', '-1', '--format=%s')
  let target = version
  if (!subject.startsWith('release:')) {
    target = nextPatch(version, versions)
    run('npm', 'version', target, '--no-git-tag-version', '--ignore-scripts')
    run('git', 'config', 'user.name', 'github-actions[bot]')
    run('git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    run('git', 'add', 'package.json', 'package-lock.json')
    run('git', 'commit', '-m', `release: ${target}`)
    // A non-fast-forward push must abort before publication, not overwrite newer work
    run('git', 'push', 'origin', 'HEAD:refs/heads/main')
  }
  const sha = run('git', 'rev-parse', 'HEAD')
  const gitHead = versions.includes(target) ? view(`${name}@${target}`, 'gitHead') : null
  const publish = needsPublication(target, versions, gitHead, sha)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${target}\nsha=${sha}\npublish=${publish}\n`)
}

function tag() {
  const { name, version } = manifest()
  const { RELEASE_VERSION: target, RELEASE_SHA: sha } = process.env
  if (target !== version || sha !== run('git', 'rev-parse', 'HEAD')) throw new Error('Release source changed')
  if (view(`${name}@${target}`, 'gitHead') !== sha) throw new Error('Published package does not match release source')
  const ref = `refs/tags/v${target}`
  const existing = run('git', 'ls-remote', 'origin', ref)
  if (existing) {
    if (existing.split(/\s+/)[0] !== sha) throw new Error(`${ref} belongs to a different commit`)
    return
  }
  run('git', 'tag', `v${target}`, sha)
  run('git', 'push', 'origin', ref)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'prepare') prepare()
  else if (process.argv[2] === 'tag') tag()
  else throw new Error('Expected prepare or tag')
}
