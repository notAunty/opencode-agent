import { open, mkdir, realpath, writeFile } from "node:fs/promises"
import { join, relative, isAbsolute, extname } from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL, fileURLToPath } from "node:url"
import type { FileInput } from "./contracts.js"
import { projectPath } from "./files.js"

const maxBytes = 5 * 1024 * 1024
const formats: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf", ".txt": "text/plain" }

export async function boundedBytes(path: string): Promise<Buffer> {
  const file = await open(path, "r")
  try {
    if (!(await file.stat()).isFile()) throw new Error("Attachment must be a regular file")
    const bytes = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > maxBytes) throw new Error("Attachment is too large")
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

export async function captureFile(directory: string, path: string): Promise<FileInput> {
  const root = await realpath(directory)
  const source = await realpath(isAbsolute(path) ? path : join(root, path))
  const child = relative(root, source)
  if (child === ".." || child.startsWith("../") || isAbsolute(child)) throw new Error("Attachment must be within the shared project")
  const extension = extname(source).toLowerCase()
  const mime = formats[extension]
  if (!mime) throw new Error("Unsupported attachment type")
  const bytes = await boundedBytes(source)
  const output = await projectPath(root, ".octg", "outgoing")
  await mkdir(output, { recursive: true, mode: 0o700 })
  // Snapshot the artifact so later agent edits cannot change an already queued disclosure
  const destination = await projectPath(root, ".octg", "outgoing", createHash("sha256").update(bytes).digest("hex") + extension)
  await writeFile(destination, bytes, { mode: 0o600 })
  return { uri: pathToFileURL(destination).href, mime, filename: `attachment${extension}` }
}

export async function uploadedFile(file: FileInput): Promise<{ data: Buffer; filename: string; mimeType?: string }> {
  return { data: await boundedBytes(fileURLToPath(file.uri)), filename: file.filename ?? "attachment", ...(file.mime ? { mimeType: file.mime } : {}) }
}
