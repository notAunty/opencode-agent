import { spawn } from "node:child_process"
import { environment } from "../dist/src/environment.js"

const env = await environment(process.cwd(), ".env")
const child = spawn("opencode", process.argv.slice(2), { env, stdio: "inherit" })
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))
child.on("error", () => { console.error("Unable to launch opencode; ensure OpenCode V2 is installed and on PATH"); process.exitCode = 1 })
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1) })
