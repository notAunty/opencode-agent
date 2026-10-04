import { Telegraf } from "telegraf"
import { ChatBridge, type ChatOptions, type ChatRouter } from "./chat.js"
import { TelegramPolling } from "./telegram.js"
import type { MessagingTransport } from "./transport.js"
import type { FileInput } from "./contracts.js"

export class Messaging implements MessagingTransport {
  private transports: MessagingTransport[] = []
  private polling?: TelegramPolling
  private chat?: ChatBridge
  constructor(options: ChatOptions, env: NodeJS.ProcessEnv) {
    if (!options.enabled) return
    const polling = options.platforms.includes("telegram") && options.telegramTransport !== "webhook"
    if (polling) {
      if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Missing environment variable TELEGRAM_BOT_TOKEN")
      this.polling = new TelegramPolling(new Telegraf(env.TELEGRAM_BOT_TOKEN), options.telegramRegisterCommands ?? true)
      this.transports.push(this.polling)
    }
    const platforms = options.platforms.filter(platform => !(polling && platform === "telegram"))
    if (platforms.length) {
      this.chat = new ChatBridge({ ...options, platforms }, env)
      this.transports.push(this.chat)
    }
  }
  attach(router: ChatRouter): void { for (const transport of this.transports) transport.attach(router) }
  async start(): Promise<void> {
    try { for (const transport of this.transports) await transport.start() }
    catch (error) { await this.stop(); throw error }
  }
  async stop(): Promise<void> { await Promise.all(this.transports.map(transport => transport.stop())) }
  async post(conversation: string, text: string, file?: FileInput): Promise<void> {
    const transport = conversation.startsWith("telegram:") && this.polling ? this.polling : this.chat
    if (!transport) throw new Error("Chat delivery is disabled")
    await transport.post(conversation, text, file)
  }
}
