import { mkdir, readFile, rename, writeFile, open, lstat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

export const godID = /^[a-z][a-z0-9_-]{0,63}$/

export async function readBounded(path: string, maxBytes: number): Promise<string> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Managed files cannot be symlinks")
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
    if (id && !godID.test(id)) throw new Error("Invalid God ID")
    return id ? join(this.directory, "TASKS", `${id}.md`) : join(this.directory, "MEMORY.md")
  }
  async context(id: string): Promise<string> {
    const [memory, task] = await Promise.all([
      readBounded(this.path(), this.maxBytes), readBounded(this.path(id), this.maxBytes),
    ])
    return `Shared long-term memory:\n${memory || "(empty)"}\n\nTask notes for ${id}:\n${task || "(empty)"}`
  }
  async save(text: string, id?: string): Promise<void> {
    if (Buffer.byteLength(text) > this.maxBytes) throw new Error("Memory exceeds its byte budget; summarize first")
    await atomicWrite(this.path(id), text)
  }
}

export async function readJSON(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
