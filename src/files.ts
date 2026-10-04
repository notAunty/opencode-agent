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
  path(id?: string): string {
    if (id && !godID.test(id)) throw new Error("Invalid Agent Session ID")
    return id ? join(this.directory, "TASKS", `${id}.md`) : join(this.directory, "MEMORY.md")
  }
  async context(id: string): Promise<string> {
    const [memory, task] = await Promise.all([
      projectPath(this.directory, "MEMORY.md").then(path => readBounded(path, this.maxBytes)),
      projectPath(this.directory, "TASKS", `${id}.md`).then(path => readBounded(path, this.maxBytes)),
    ])
    return `Shared long-term memory:\n${memory || "(empty)"}\n\nTask notes for ${id}:\n${task || "(empty)"}`
  }
  async save(text: string, id?: string): Promise<void> {
    if (Buffer.byteLength(text) > this.maxBytes) throw new Error("Memory exceeds its byte budget; summarize first")
    this.path(id)
    await atomicWrite(await projectPath(this.directory, ...(id ? ["TASKS", `${id}.md`] : ["MEMORY.md"])), text)
  }
}

export async function readJSON(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
