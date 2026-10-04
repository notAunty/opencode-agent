import { createServer, type Server } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { Chat, type Adapter, type Message, type Thread, type SlashCommandEvent, type WebhookOptions } from "chat"
import { createSlackAdapter } from "@chat-adapter/slack"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { createDiscordAdapter } from "@chat-adapter/discord"
import { createRedisState } from "@chat-adapter/state-redis"
import type { FileInput, Messenger } from "./contracts.js"
import type { AgentSessions } from "./service.js"
import type { Timers, TimerWhen } from "./timers.js"
import { uploadedFile } from "./transfers.js"
import { projectPath } from "./files.js"
import { chatCommands, registerTelegramCommands } from "./commands.js"

export interface ChatOptions {
  enabled: boolean
  port: number
  host: string
  platforms: ("slack" | "telegram" | "discord")[]
  discordGateway: boolean
  telegramRegisterCommands?: boolean
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}
export function timerWhen(value: { delayMs?: number; at?: string }): TimerWhen {
  if ((value.delayMs === undefined) === (value.at === undefined)) throw new Error("Specify exactly one delayMs or timezone-aware at")
  return value.delayMs !== undefined ? { delayMs: value.delayMs } : { at: value.at! }
}

export class ChatRouter {
  constructor(private service: AgentSessions, private timers: Timers, private directory: string, private changed: () => void = () => {}) {}
  async slash(event: SlashCommandEvent, thread: (id: string) => Pick<Thread, "subscribe">): Promise<void> {
    const id = event.channel.id.startsWith("slack:") && event.channel.id.split(":").length === 2 ? `${event.channel.id}:` : event.channel.id
    const command = event.command === "/cancel_recovery" ? "cancel-recovery" : event.command.slice(1)
    await this.handle({ id, post: event.channel.post.bind(event.channel), subscribe: () => thread(id).subscribe() }, {
      author: event.user, text: `!${command}${event.text ? ` ${event.text}` : ""}`, id: "slash-command", attachments: [],
    })
  }
  async handle(thread: Pick<Thread, "id" | "post" | "subscribe">, message: Pick<Message, "author" | "text" | "id" | "attachments">): Promise<void> {
    if (message.author.isBot !== false || message.author.isMe || message.author.isSystem) return
    const platform = thread.id.split(":")[0]
    if (!["telegram", "slack", "discord"].includes(platform ?? "")) return
    const actor = `${platform}:${message.author.userId}`
    const text = message.text.trim()
    try {
      if (text.startsWith("!agent ")) {
        const god = await this.service.link(text.slice(7).trim(), thread.id, actor)
        await thread.subscribe()
        await thread.post(`Linked to ${god.id}. Session: ${god.sessionID}. Everyone in this conversation can read its replies`)
        return
      }
      let god
      try { god = await this.service.byConversation(thread.id, actor) }
      catch (error) {
        // Slack slash commands are channel-scoped; explicit thread links still take precedence
        if (!(error instanceof Error) || !/not linked/.test(error.message) || platform !== "slack") throw error
        const id = `slack:${thread.id.split(":")[1]}:`
        god = await this.service.byConversation(id, actor)
        const original = thread
        thread = { id, post: original.post.bind(original), subscribe: () => original.subscribe() }
      }
      if (text === "!status") { await thread.post(JSON.stringify(await this.service.status(god.id, actor))); return }
      if (text === "!timers") { await thread.post(JSON.stringify(await this.timers.list(god.id))); return }
      if (text.startsWith("!cancel ")) { await thread.post(await this.timers.cancel(god.id, text.slice(8).trim()) ? "Timer cancelled" : "Timer not found"); return }
      if (text === "!cancel-recovery") { await this.service.cancelRecovery(god.id, actor); await thread.post("Recovery cancelled"); return }
      if (text === "!stop") { await this.service.stop(god.id, actor); await thread.post("Agent interrupted; timers remain scheduled"); return }
      if (text === "!retry") { await this.service.retry(god.id, actor); this.changed(); await thread.post("Saved inbox will be retried"); return }
      if (text === "!unlink") { await this.service.unlink(god.id, thread.id, actor); await thread.post("Conversation unlinked"); return }
      if (text.startsWith("!wake ")) {
        const separator = text.indexOf(" ", 6)
        if (separator < 0) throw new Error("Use !wake <seconds|ISO timestamp> <prompt>")
        const time = text.slice(6, separator)
        const when = /^\d+(\.\d+)?$/.test(time) ? { delayMs: Number(time) * 1000 } : { at: time }
        const timer = await this.timers.create(god.id, text.slice(separator + 1), timerWhen(when))
        await thread.post(`Timer ${timer.id}: ${new Date(timer.dueAt).toISOString()}`)
        return
      }
      if (text.startsWith("!")) { await thread.post("Commands: !agent <id>, !status, !wake <seconds|ISO time> <prompt>, !timers, !cancel <id>, !cancel-recovery, !stop, !retry, !unlink"); return }
      // Authorization precedes adapter-controlled download, avoiding unauthorized file and URL fetches
      const files = await this.attachments(message)
      await this.service.accept(god.id, text || "Please inspect the attached files", `chat:${thread.id}:${message.id}`, actor, files)
      this.changed()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed"
      const safe = /access denied|not linked|Specify|Use !wake|Invalid timer|Absolute time|too large|inbox is full|Unsupported attachment/.test(message)
      await thread.post(safe ? message : "Request could not be saved. Check the OpenCode session and retry; no completed actions were replayed")
    }
  }
  private async attachments(message: Pick<Message, "attachments">): Promise<FileInput[]> {
    if (message.attachments.length > 8) throw new Error("Prompt is too large")
    const files: FileInput[] = []
    for (const attachment of message.attachments) {
      if (attachment.size && attachment.size > 5 * 1024 * 1024) throw new Error("Attachment is too large")
      const mime = attachment.mimeType ?? (attachment.type === "image" ? "image/jpeg" : "application/octet-stream")
      if (!/^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(mime)) throw new Error("Unsupported attachment type")
      let bytes: Buffer
      if (Buffer.isBuffer(attachment.data)) bytes = attachment.data
      else if (attachment.data instanceof Blob) bytes = Buffer.from(await attachment.data.arrayBuffer())
      else if (attachment.fetchData) {
        const data = await attachment.fetchData()
        bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
      }
      else throw new Error("Unsupported attachment download")
      if (bytes.length > 5 * 1024 * 1024) throw new Error("Attachment is too large")
      const uploads = await projectPath(this.directory, ".octg", "uploads")
      const path = await projectPath(this.directory, ".octg", "uploads", createHash("sha256").update(bytes).digest("hex"))
      await mkdir(uploads, { recursive: true, mode: 0o700 })
      await writeFile(path, bytes, { mode: 0o600 })
      files.push({ uri: pathToFileURL(path).href, mime, filename: attachment.name ?? "attachment" })
    }
    return files
  }
}

export class ChatBridge implements Messenger {
  private bot?: Chat
  private server?: Server
  private stopping = false
  private gateway = new AbortController()
  private tasks = new Set<Promise<unknown>>()
  private handler?: ChatRouter
  constructor(private options: ChatOptions, private env: NodeJS.ProcessEnv = process.env) {}
  attach(router: ChatRouter): void { this.handler = router }
  async post(conversation: string, text: string, file?: FileInput): Promise<void> {
    if (!this.bot) throw new Error("Chat delivery is disabled")
    if (file) { await this.bot.thread(conversation).post({ raw: text, files: [await uploadedFile(file)] }); return }
    // Conservative plain-text chunks work on all three adapters without invalid split Markdown
    const chunks = Array.from(text)
    for (let offset = 0; offset < chunks.length; offset += 1800) await this.bot.thread(conversation).post(chunks.slice(offset, offset + 1800).join(""))
  }
  private track(promise: Promise<unknown>): void {
    this.tasks.add(promise)
    void promise.catch(() => console.error("octg: chat handler failed; inspect the saved inbox")).finally(() => this.tasks.delete(promise))
  }
  async start(): Promise<void> {
    if (!this.options.enabled) return
    if (!this.handler) throw new Error("Chat router is not attached")
    const adapters: Record<string, Adapter> = {}
    for (const platform of this.options.platforms) {
      if (platform === "slack") adapters.slack = createSlackAdapter({ mode: "webhook", botToken: required(this.env, "SLACK_BOT_TOKEN"), signingSecret: required(this.env, "SLACK_SIGNING_SECRET") })
      if (platform === "telegram") adapters.telegram = createTelegramAdapter({ mode: "webhook", botToken: required(this.env, "TELEGRAM_BOT_TOKEN"), secretToken: required(this.env, "TELEGRAM_WEBHOOK_SECRET_TOKEN"), userName: required(this.env, "TELEGRAM_BOT_USERNAME") })
      if (platform === "discord") adapters.discord = createDiscordAdapter({ botToken: required(this.env, "DISCORD_BOT_TOKEN"), applicationId: required(this.env, "DISCORD_APPLICATION_ID"), publicKey: required(this.env, "DISCORD_PUBLIC_KEY") })
    }
    this.bot = new Chat({ userName: "agent", adapters, state: createRedisState({ url: required(this.env, "REDIS_URL"), keyPrefix: "octg:" }), concurrency: "concurrent" })
    const handler = async (thread: Thread, message: Message) => this.handler!.handle(thread, message)
    this.bot.onNewMention(handler)
    this.bot.onDirectMessage(handler)
    this.bot.onSubscribedMessage(handler)
    this.bot.onSlashCommand(chatCommands.map(({ command }) => `/${command}`), event => this.handler!.slash(event, id => this.bot!.thread(id)))
    await this.bot.initialize()
    this.server = createServer((request, response) => {
      void (async () => {
        const platform = request.url?.match(/^\/chat\/(slack|telegram|discord)$/)?.[1]
        const webhook = platform && this.bot?.webhooks[platform]
        if (request.method !== "POST" || !webhook || this.stopping) { response.writeHead(404).end(); return }
        const parts: Buffer[] = []; let length = 0
        for await (const part of request) {
          length += Buffer.byteLength(part)
          if (length > 2 * 1024 * 1024) { response.writeHead(413).end(); return }
          parts.push(Buffer.from(part))
        }
        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value)
        const result = await webhook(new Request(`http://localhost${request.url}`, { method: "POST", headers, body: Buffer.concat(parts) }), { waitUntil: promise => this.track(promise) })
        response.writeHead(result.status, Object.fromEntries(result.headers.entries())).end(Buffer.from(await result.arrayBuffer()))
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); console.error("octg: webhook failed") })
    })
    this.server.requestTimeout = 15_000
    this.server.headersTimeout = 10_000
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.options.port, this.options.host, resolve) })
    if (adapters.telegram && this.options.telegramRegisterCommands) {
      this.track(registerTelegramCommands(required(this.env, "TELEGRAM_BOT_TOKEN")).catch(() => {
        console.error("octg: Telegram command menu registration failed; chat remains available")
      }))
    }
    const discord = adapters.discord
    if (discord && this.options.discordGateway) {
      const adapter = discord as ReturnType<typeof createDiscordAdapter>
      this.track((async () => {
        while (!this.stopping) {
          const work: Promise<unknown>[] = []
          const options: WebhookOptions = { waitUntil: promise => work.push(promise) }
          try {
            await adapter.startGatewayListener(options, 600_000, this.gateway.signal)
            await Promise.allSettled(work)
          } catch {
            if (!this.stopping) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 10_000); this.gateway.signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true }) })
          }
        }
      })())
    }
  }
  async stop(): Promise<void> {
    this.stopping = true
    this.gateway.abort()
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())) }
    await Promise.allSettled(this.tasks)
    await this.bot?.shutdown()
  }
}
