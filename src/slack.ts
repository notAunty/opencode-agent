import { SocketModeClient, LogLevel } from "@slack/socket-mode"
import { WebClient } from "@slack/web-api"
import type { Attachment } from "chat"
import type { ChatRouter } from "./chat.js"
import type { FileInput } from "./contracts.js"
import type { MessagingTransport } from "./transport.js"
import { uploadedFile } from "./transfers.js"
import { chatCommands } from "./commands.js"

interface SlackEvent {
  type: string; channel: string; user?: string; text?: string; ts: string; thread_ts?: string
  channel_type?: string; bot_id?: string; subtype?: string
  files?: { url_private_download?: string; url_private?: string; mimetype?: string; name?: string; size?: number }[]
}
interface Envelope {
  ack(): Promise<void>
  event?: SlackEvent
  body: { command?: string; text?: string; user_id?: string; channel_id?: string; event_id?: string; trigger_id?: string }
}
const logger = {
  getLevel: () => LogLevel.ERROR, setLevel() {}, setName() {}, debug() {}, info() {},
  warn() { console.error("octg: Slack transport warning") },
  error() { console.error("octg: Slack transport error") },
}

export class SlackSocket implements MessagingTransport {
  private router?: ChatRouter
  private tasks = new Set<Promise<void>>()
  private stopping = false
  private userID?: string
  static create(token: string, appToken: string): SlackSocket {
    const clientOptions = { logger, timeout: 10_000, retryConfig: { retries: 0 } }
    return new SlackSocket(new SocketModeClient({ appToken, logger, clientOptions }), new WebClient(token, clientOptions), token)
  }
  constructor(private socket: SocketModeClient, private web: WebClient, private token: string) {
    for (const type of ["message", "app_mention", "slash_commands"]) {
      socket.on(type, (envelope: Envelope) => {
        if (this.stopping) return
        const task = this.receive(envelope).catch(() => { console.error("octg: Slack handler failed; inspect the saved inbox") })
        this.tasks.add(task)
        void task.finally(() => this.tasks.delete(task))
      })
    }
    socket.on("error", () => console.error("octg: Slack socket error; reconnect is transport-only"))
  }
  attach(router: ChatRouter): void { this.router = router }
  async start(): Promise<void> {
    if (!this.router) throw new Error("Chat router is not attached")
    try {
      this.userID = (await this.web.auth.test()).user_id
      if (!this.userID) throw new Error("Bot identity is unavailable")
      await this.socket.start()
    } catch { throw new Error("Slack Socket Mode setup failed; check app token, bot token and Socket Mode settings") }
  }
  async stop(): Promise<void> {
    this.stopping = true
    await this.socket.disconnect()
    await Promise.allSettled(this.tasks)
  }
  async post(conversation: string, text: string, file?: FileInput): Promise<void> {
    const match = /^slack:([^:]+):([^:]*)$/.exec(conversation)
    if (!match) throw new Error("Invalid Slack conversation")
    const channel = match[1]!
    const thread_ts = match[2] || undefined
    if (file) {
      const upload = await uploadedFile(file)
      const destination = thread_ts ? { channel_id: channel, thread_ts } : { channel_id: channel }
      await this.web.files.uploadV2({ ...destination, file: Buffer.from(upload.data as Buffer), filename: upload.filename })
    }
    const chars = Array.from(text)
    for (let i = 0; i < chars.length; i += 1800) {
      await this.web.chat.postMessage({ channel, thread_ts, text: chars.slice(i, i + 1800).join(""), mrkdwn: false })
    }
  }
  private async receive({ ack, event, body }: Envelope): Promise<void> {
    // Slack's acknowledgement deadline is independent of durable admission and attachment downloads
    await ack()
    if (!this.router || this.stopping) return
    const command = body.command?.slice(1)
    if (command) {
      if (!chatCommands.some(entry => entry.command === command) || !body.user_id || !body.channel_id) return
      await this.route(`slack:${body.channel_id}:`, body.user_id, body.trigger_id ?? "slash-command",
        `!${command === "cancel_recovery" ? "cancel-recovery" : command}${body.text ? ` ${body.text}` : ""}`, [])
      return
    }
    if (!event?.user || event.bot_id || event.user === this.userID || event.subtype && event.subtype !== "file_share") return
    const root = `slack:${event.channel}:`
    const id = event.channel_type === "im" && !event.thread_ts ? root : `slack:${event.channel}:${event.thread_ts ?? event.ts}`
    if (event.channel_type !== "im" && event.type !== "app_mention" && !await this.router.linked(id) && !await this.router.linked(root)) return
    const attachments: Attachment[] = (event.files ?? []).map(file => ({
      type: file.mimetype?.startsWith("image/") ? "image" : "file", mimeType: file.mimetype, name: file.name, size: file.size,
      fetchData: async () => {
        const url = new URL(file.url_private_download ?? file.url_private ?? "")
        if (url.protocol !== "https:" || url.hostname !== "files.slack.com") throw new Error("Unsupported attachment download")
        const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) })
        if (!response.ok || !response.body) throw new Error("Unsupported attachment download")
        const parts: Uint8Array[] = []; let length = 0
        for await (const part of response.body) {
          length += part.length
          if (length > 5 * 1024 * 1024) throw new Error("Attachment is too large")
          parts.push(part)
        }
        return Buffer.concat(parts)
      },
    }))
    const text = (event.text ?? "").replace(new RegExp(`<@${this.userID}>\\s*`, "g"), "").trim()
    if (!text && !attachments.length) return
    await this.route(id, event.user, event.ts, text, attachments)
  }
  private async route(id: string, user: string, key: string, text: string, attachments: Attachment[]): Promise<void> {
    await this.router!.handle({ id, subscribe: async () => {}, post: value => this.post(id, value) }, {
      id: key, text, attachments, author: { userId: user, userName: user, fullName: user, isBot: false, isMe: false },
    })
  }
}
