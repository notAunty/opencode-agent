import { mkdir, readFile, rename, open, lstat, realpath } from "node:fs/promises"
import { dirname, join, relative, isAbsolute, sep } from "node:path"
import { randomUUID } from "node:crypto"

export const godID = /^[a-z][a-z0-9_-]{0,63}$/

export async function projectPath(directory: string, ...parts: string[]): Promise<string> {
  const root = await realpath(directory)
  const path = join(root, ...parts)
  const child = relative(root, path)
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("Managed path must remain in the project")
  let current = root
  for (const part of child.split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Managed paths cannot contain symlinks")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return path
}

export async function readBounded(path: string, maxBytes: number): Promise<string> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Managed memory must be a regular file, not a symlink")
    const file = await open(path, "r")
    try {
      const bytes = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      const text = bytes.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8")
      return text + (bytesRead > maxBytes ? "\n[Memory truncated; read the file deliberately if needed]" : "")
    } finally { await file.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Managed files cannot be symlinks")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try { await file.writeFile(text); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
}

export class MemoryFiles {
  constructor(private directory: string, private maxBytes = 12_000) {}
  async context(id: string): Promise<string> {
    if (!godID.test(id)) throw new Error("Invalid Agent Session ID")
    const [memory, task] = await Promise.all([
      projectPath(this.directory, "MEMORY.md").then(path => readBounded(path, this.maxBytes)),
      projectPath(this.directory, "TASKS", `${id}.md`).then(path => readBounded(path, this.maxBytes)),
    ])
    return `Shared long-term memory:\n${memory || "(empty)"}\n\nTask index for ${id}:\n${task || "(empty)"}`
  }
}

export async function readJSON(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
