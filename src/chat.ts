import { createServer, type Server } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { Chat, type Adapter, type Message, type Thread, type SlashCommandEvent, type WebhookOptions, type StateAdapter, type Logger } from "chat"
import { createSlackAdapter } from "@chat-adapter/slack"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { createDiscordAdapter } from "@chat-adapter/discord"
import { createRedisState } from "@chat-adapter/state-redis"
import type { FileInput, Storage } from "./contracts.js"
import type { AgentSessions } from "./service.js"
import type { Timers, TimerWhen } from "./timers.js"
import { uploadedFile } from "./transfers.js"
import { projectPath } from "./files.js"
import { chatCommands, registerTelegramCommands } from "./commands.js"
import type { MessagingTransport } from "./transport.js"
import { errorFields, trace } from "./diagnostics.js"
import { localChatState } from "./chat-state.js"
import { createSocketSlackAdapter } from "./chat-slack.js"

export interface ChatOptions {
  enabled: boolean
  port: number
  host: string
  platforms: ("slack" | "telegram" | "discord")[]
  discordGateway: boolean
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
  async linked(conversation: string): Promise<boolean> {
    return (await this.service.list()).some(agent => agent.conversations.some(binding => binding.id === conversation))
  }
  async slash(event: SlashCommandEvent, thread: (id: string) => Pick<Thread, "subscribe">, post?: (id: string, text: string) => Promise<unknown>): Promise<void> {
    const id = event.channel.id.startsWith("slack:") && event.channel.id.split(":").length === 2 ? `${event.channel.id}:` : event.channel.id
    const command = event.command === "/cancel_recovery" ? "cancel-recovery" : event.command.slice(1)
    await this.handle({ id, post: post ? text => post(id, text) : event.channel.post.bind(event.channel), subscribe: () => thread(id).subscribe() }, {
      author: event.user, text: `!${command}${event.text ? ` ${event.text}` : ""}`, id: "slash-command", attachments: [],
    })
  }
  async handle(thread: { id: string; post(text: string): Promise<unknown>; subscribe(): Promise<unknown> }, message: Pick<Message, "author" | "text" | "id" | "attachments">): Promise<void> {
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
      trace("chat.route.selected", message.id)
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
      trace("chat.authorized", message.id)
      trace("chat.attachments.started", message.id, { count: message.attachments.length })
      const files = await this.attachments(message)
      trace("chat.staging.started", message.id)
      const admission = await this.service.accept(god.id, text || "Please inspect the attached files", `chat:${thread.id}:${message.id}`, actor, files)
      trace("chat.staged", message.id, { nativeID: admission.id, duplicate: admission.duplicate })
      this.changed()
    } catch (error) {
      const reason = error instanceof Error && /access denied/.test(error.message) ? "access_denied"
        : error instanceof Error && /not linked/.test(error.message) ? "not_linked" : "request_failed"
      trace("chat.routing.failed", message.id, { reason, ...errorFields(error) })
      const explanation = error instanceof Error ? error.message : "Request failed"
      const safe = /access denied|not linked|Specify|Use !wake|Invalid timer|Absolute time|too large|inbox is full|Unsupported attachment/.test(explanation)
      await thread.post(safe ? explanation : "Request could not be saved. Check the OpenCode session and retry; no completed actions were replayed")
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

export function chatLogger(platform: string): Logger {
  const emit = (level: string, message: string, args: unknown[]) => {
    // SDK log arguments can contain credentials, message bodies and download URLs.
    const known: Record<string, string> = {
      "Slack socket mode connected": "connected",
      "Slack socket mode disconnected": "disconnected",
      "Processing socket mode retry": "redelivery",
      "Telegram polling started": "polling.started",
      "Telegram polling stopped": "polling.stopped",
      "Telegram polling failed": "polling.failed",
      "Telegram polling update processing failed": "polling.dispatch.failed",
    }
    const stage = known[message] ?? (level === "warn" || level === "error" ? `sdk.${level}` : undefined)
    if (!stage) return
    const error = args.find(value => value instanceof Error)
      ?? args.find(value => value && typeof value === "object" && "error" in value)
    trace(`${platform}.${stage}`, platform, { ...(error ? errorFields(error instanceof Error ? error : (error as { error: unknown }).error) : {}) })
  }
  return {
    child: () => chatLogger(platform), debug() {},
    info: (message, ...args) => emit("info", message, args),
    warn: (message, ...args) => emit("warn", message, args),
    error: (message, ...args) => emit("error", message, args),
  }
}

export function createChatAdapters(platforms: ChatOptions["platforms"], env: NodeJS.ProcessEnv, waitUntil?: (promise: Promise<unknown>) => void): Record<string, Adapter> {
  const adapters: Record<string, Adapter> = {}
  for (const platform of platforms) {
    const logger = chatLogger(platform)
    if (platform === "slack") adapters.slack = createSocketSlackAdapter({
      mode: "socket", botToken: required(env, "SLACK_BOT_TOKEN"), appToken: required(env, "SLACK_APP_TOKEN"), logger,
      // The durable outbox owns delivery retries; transport retries must not multiply uncertain sends.
      webClientOptions: { timeout: 10_000, retryConfig: { retries: 0 } },
    }, waitUntil)
    if (platform === "telegram") adapters.telegram = createTelegramAdapter({
      mode: "polling", botToken: required(env, "TELEGRAM_BOT_TOKEN"), logger,
      allowedUserIds: [], mentionOnReply: false, businessMode: false,
      longPolling: { deleteWebhook: false, dropPendingUpdates: false, allowedUpdates: ["message"], timeout: 25 },
    })
    if (platform === "discord") adapters.discord = createDiscordAdapter({
      botToken: required(env, "DISCORD_BOT_TOKEN"), applicationId: required(env, "DISCORD_APPLICATION_ID"), publicKey: required(env, "DISCORD_PUBLIC_KEY"), logger,
    })
  }
  return adapters
}

export interface ChatRuntime {
  storage?: Storage
  state?: StateAdapter
  adapters?: typeof createChatAdapters
  fetch?: typeof fetch
}

async function telegramPreflight(token: string, request: typeof fetch): Promise<void> {
  try {
    const response = await request(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: AbortSignal.timeout(10_000), redirect: "error" })
    const info = await response.json() as { ok?: boolean; result?: { url?: string } }
    if (!response.ok || !info.ok || !info.result || info.result.url) throw new Error("Unavailable or configured webhook")
  } catch {
    throw new Error("Telegram polling setup failed; check credentials and remove any existing webhook manually")
  }
}

export class ChatBridge implements MessagingTransport {
  private bot?: Chat
  private server?: Server
  private stopping = false
  private gateway = new AbortController()
  private tasks = new Set<Promise<unknown>>()
  private handler?: ChatRouter
  private heartbeat?: ReturnType<typeof setInterval>
  private shutdown?: Promise<void>
  private lastReceived = new Map<string, number>()
  constructor(private options: ChatOptions, private env: NodeJS.ProcessEnv = process.env, private runtime: ChatRuntime = {}) {}
  attach(router: ChatRouter): void { this.handler = router }
  async post(conversation: string, text: string, file?: FileInput): Promise<void> {
    const platform = conversation.split(":")[0]!
    if (!this.bot || !this.bot.getAdapter(platform)) throw new Error("Chat delivery is disabled")
    if (platform === "discord" && file) { await this.bot.thread(conversation).post({ raw: text, files: [await uploadedFile(file)] }); return }
    if (file) await this.bot.thread(conversation).post({ raw: "", files: [await uploadedFile(file)] })
    // Separate file delivery prevents platform caption limits from truncating long notices.
    const chunks = Array.from(text)
    for (let offset = 0; offset < chunks.length; offset += 1800) {
      const chunk = chunks.slice(offset, offset + 1800).join("")
      await this.bot.thread(conversation).post(platform === "discord" ? chunk : { raw: chunk })
    }
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.tasks.add(promise)
    void promise.catch(() => console.error("octg: chat handler failed; inspect the saved inbox")).finally(() => this.tasks.delete(promise))
    return promise
  }
  private receive(thread: Thread, message: Message): Promise<void> {
    return this.track((async () => {
      const platform = thread.id.split(":")[0]!
      const raw = message.raw as { text?: string; caption?: string; media_group_id?: string; subtype?: string; channel_type?: string; message_id?: number }
      // Preserve pre-migration admission keys even though the SDK adds chat IDs to Telegram message IDs.
      const key = platform === "telegram" && typeof raw.message_id === "number" ? String(raw.message_id) : message.id
      trace(`${platform}.received`, key)
      this.lastReceived.set(platform, Date.now())
      if (this.stopping) { trace(`${platform}.filtered`, key, { reason: "stopping" }); return }
      if (platform === "discord") { await this.handler!.handle(thread, message); return }
      if (message.author.isBot !== false || message.author.isMe || message.author.isSystem || platform === "slack" && raw.subtype && raw.subtype !== "file_share") {
        trace(`${platform}.filtered`, key, { reason: "bot_or_unsupported_event" }); return
      }
      if (platform === "slack" && raw.channel_type !== "im" && !message.isMention && !await this.handler!.linked(thread.id) && !await this.handler!.linked(`slack:${thread.id.split(":")[1]}:`)) {
        trace("slack.filtered", key, { reason: "unlinked_channel" }); return
      }
      const slack = platform === "slack" ? this.bot!.getAdapter("slack") as ReturnType<typeof createSlackAdapter> : undefined
      const text = slack?.botUserId && typeof raw.text === "string"
        ? raw.text.replace(new RegExp(`<@${slack.botUserId}>\\s*`, "g"), "").trim()
        : platform === "telegram" && !raw.media_group_id ? (raw.text ?? raw.caption ?? message.text).trim() : message.text.trim()
      if (!text && !message.attachments.length) { trace(`${platform}.filtered`, key, { reason: "empty" }); return }
      trace(`${platform}.routing`, key)
      await this.handler!.handle({ id: thread.id, subscribe: () => thread.subscribe(), post: value => this.post(thread.id, value) }, {
        id: key, text, attachments: message.attachments, author: message.author,
      })
    })())
  }
  async start(): Promise<void> {
    if (!this.options.enabled) return
    if (!this.handler) throw new Error("Chat router is not attached")
    const adapters = (this.runtime.adapters ?? createChatAdapters)(this.options.platforms, this.env, promise => { this.track(promise) })
    if (!Object.keys(adapters).length) return
    if (adapters.telegram) await telegramPreflight(required(this.env, "TELEGRAM_BOT_TOKEN"), this.runtime.fetch ?? fetch)
    const state = this.runtime.state ?? (adapters.discord ? createRedisState({ url: required(this.env, "REDIS_URL"), keyPrefix: "octg:" }) : localChatState(this.runtime.storage))
    this.bot = new Chat({ userName: "agent", adapters, state, concurrency: "concurrent", logger: chatLogger("chat") })
    const handler = (thread: Thread, message: Message) => this.receive(thread, message)
    this.bot.onNewMention(handler)
    this.bot.onDirectMessage(handler)
    this.bot.onSubscribedMessage(handler)
    // SDK subscriptions are not the authority: owner RPC links and channel-wide links must work after restart.
    this.bot.onNewMessage(/[\s\S]*/, (thread, message) => thread.id.startsWith("discord:") ? Promise.resolve() : handler(thread, message))
    this.bot.onSlashCommand(event => this.track((async () => {
      if (this.stopping) return
      trace(`${event.adapter.name}.command.received`, event.triggerId ?? "slash-command")
      if (!chatCommands.some(({ command }) => event.command === `/${command}`)) {
        if (event.adapter.name === "telegram") await handler(this.bot!.thread(event.channel.id), event.adapter.parseMessage(event.raw))
        return
      }
      await this.handler!.slash(event, id => this.bot!.thread(id), event.adapter.name === "discord" ? undefined : (id, text) => this.post(id, text))
    })()))
    const initializing: Promise<void>[] = []
    for (const [platform, adapter] of Object.entries(adapters)) {
      const disconnect = adapter.disconnect?.bind(adapter)
      if (disconnect) {
        let disconnecting: Promise<void> | undefined
        adapter.disconnect = () => disconnecting ??= (async () => {
          trace(`${platform}.stopping`, platform)
          await disconnect()
          trace(`${platform}.stopped`, platform)
        })()
      }
      const initialize = adapter.initialize.bind(adapter)
      adapter.initialize = bot => {
        trace(`${platform}.starting`, platform)
        const task = initialize(bot).then(() => {
          if ((platform === "slack" && !(adapter as ReturnType<typeof createSlackAdapter>).botUserId)
            || (platform === "telegram" && !(adapter as ReturnType<typeof createTelegramAdapter>).botUserId)) throw new Error("Bot identity is unavailable")
          trace(`${platform}.ready`, platform)
        })
        initializing.push(task)
        return task
      }
    }
    try { await this.bot.initialize() }
    catch (error) {
      await Promise.allSettled(initializing)
      trace("chat.start.failed", "chat", errorFields(error))
      await this.stop()
      throw new Error("Chat SDK setup failed; check transport credentials and settings")
    }
    this.heartbeat = setInterval(() => {
      for (const platform of Object.keys(adapters)) trace(`${platform}.active`, platform, {
        ...(this.lastReceived.has(platform) ? { lastReceivedAgoMs: Date.now() - this.lastReceived.get(platform)! } : {}),
      })
    }, 60_000)
    this.heartbeat.unref()
    if (adapters.telegram) this.track(registerTelegramCommands(required(this.env, "TELEGRAM_BOT_TOKEN"), this.runtime.fetch ?? fetch).catch(() => {
      console.error("octg: Telegram command menu registration failed; chat remains available")
    }))
    if (!adapters.discord) return
    this.server = createServer((request, response) => {
      void (async () => {
        const platform = request.url?.match(/^\/chat\/(discord)$/)?.[1]
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
  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown
    this.stopping = true
    this.shutdown = this.finishStop()
    return this.shutdown
  }
  private async finishStop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.gateway.abort()
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())) }
    // Stop ingress while state is still available to handlers already saving their inbox entries.
    await Promise.allSettled(this.options.platforms.map(platform => this.bot?.getAdapter(platform)?.disconnect?.()))
    while (this.tasks.size) await Promise.allSettled(this.tasks)
    await this.bot?.shutdown()
  }
}
