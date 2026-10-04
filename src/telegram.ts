import { Telegraf, type Context } from "telegraf"
import { AbortController } from "abort-controller"
import type { ChatRouter } from "./chat.js"
import type { FileInput } from "./contracts.js"
import type { MessagingTransport } from "./transport.js"
import { chatCommands } from "./commands.js"
import { uploadedFile } from "./transfers.js"

export class TelegramPolling implements MessagingTransport {
  private router?: ChatRouter
  private abort = new AbortController()
  private task?: Promise<void>
  private offset = 0
  constructor(private bot: Telegraf<Context>) {
    for (const { command } of chatCommands) {
      bot.command(command, ctx => this.receive(ctx, `!${command === "cancel_recovery" ? "cancel-recovery" : command}${ctx.payload ? ` ${ctx.payload}` : ""}`))
    }
    bot.on("message", ctx => this.receive(ctx))
    bot.catch(() => { console.error("octg: Telegram handler failed; inspect the saved inbox") })
  }
  attach(router: ChatRouter): void { this.router = router }
  async post(conversation: string, text: string, file?: FileInput): Promise<void> {
    const match = /^telegram:(-?\d+)(?::(\d+))?$/.exec(conversation)
    if (!match) throw new Error("Invalid Telegram conversation")
    const target = match[1]!
    const options = match[2] ? { message_thread_id: Number(match[2]) } : {}
    if (file) {
      const upload = await uploadedFile(file)
      await this.bot.telegram.sendDocument(target, { source: Buffer.from(upload.data as Buffer), filename: upload.filename }, options)
    }
    const chars = Array.from(text)
    for (let i = 0; i < chars.length; i += 1800) await this.bot.telegram.sendMessage(target, chars.slice(i, i + 1800).join(""), options)
  }
  async start(): Promise<void> {
    if (!this.router) throw new Error("Chat router is not attached")
    try {
      const webhook = await this.bot.telegram.getWebhookInfo()
      if (webhook.url) throw new Error("webhook configured")
      this.bot.botInfo = await this.bot.telegram.getMe()
      await this.bot.telegram.setMyCommands([...chatCommands])
    } catch {
      throw new Error("Telegram polling setup failed; check credentials and remove any existing webhook manually")
    }
    // launch() deletes webhooks; explicit getUpdates preserves deployment-owned webhook configuration
    this.task = this.poll()
  }
  private async poll(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.bot.telegram.callApi("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message"] }, { signal: this.abort.signal })
        for (const update of updates) {
          if (this.abort.signal.aborted) break
          await this.bot.handleUpdate(update)
          this.offset = update.update_id + 1
        }
      } catch {
        if (this.abort.signal.aborted) break
        console.error("octg: Telegram polling failed; retrying transport only")
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener("abort", done); resolve() }
          const timer = setTimeout(done, 5000)
          this.abort.signal.addEventListener("abort", done, { once: true })
          if (this.abort.signal.aborted) done()
        })
      }
    }
  }
  async stop(): Promise<void> { this.abort.abort(); await this.task }
  private async receive(ctx: Context, command?: string): Promise<void> {
    if (!ctx.message || !ctx.chat || !ctx.from || !this.router) return
    const message = ctx.message
    const topic = "message_thread_id" in message ? message.message_thread_id : undefined
    const id = `telegram:${ctx.chat.id}${topic ? `:${topic}` : ""}`
    const photo = "photo" in message ? message.photo.at(-1) : undefined
    const document = "document" in message ? message.document : undefined
    const attachment = photo ?? document
    await this.router.handle({ id, subscribe: async () => {}, post: value => this.post(id, value) }, {
      id: String(message.message_id),
      author: { userId: String(ctx.from.id), userName: ctx.from.username ?? String(ctx.from.id), fullName: ctx.from.first_name, isBot: ctx.from.is_bot, isMe: false },
      text: command ?? ("text" in message ? message.text : "caption" in message ? message.caption ?? "" : ""),
      attachments: attachment ? [{ type: photo ? "image" : "file", size: attachment.file_size,
        mimeType: photo ? "image/jpeg" : document?.mime_type, name: document?.file_name,
        fetchData: async () => {
          const url = await this.bot.telegram.getFileLink(attachment.file_id)
          if (url.protocol !== "https:" || url.hostname !== "api.telegram.org") throw new Error("Unsupported attachment download")
          const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" })
          if (!response.ok || !response.body) throw new Error("Unsupported attachment download")
          const parts: Uint8Array[] = []; let length = 0
          for await (const part of response.body) {
            length += part.length
            if (length > 5 * 1024 * 1024) throw new Error("Attachment is too large")
            parts.push(part)
          }
          return Buffer.concat(parts)
        },
      }] : [],
    })
  }
}
