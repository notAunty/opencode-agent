import { readFile, lstat } from "node:fs/promises"
import { parse } from "dotenv"
import { projectPath } from "./files.js"

export async function environment(directory: string, envFile?: string, inherited: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  let values: Record<string, string> = {}
  if (envFile) {
    const path = await projectPath(directory, envFile)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size > 64 * 1024) throw new Error("Environment file must be a regular file no larger than 64 KiB")
      const bytes = await readFile(path)
      if (bytes.length > 64 * 1024) throw new Error("Environment file exceeds 64 KiB")
      values = parse(bytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return { ...values, ...Object.fromEntries(Object.entries(inherited).filter(([, value]) => value !== undefined)) }
}
