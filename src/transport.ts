import type { ChatRouter } from "./chat.js"
import type { Messenger } from "./contracts.js"

export interface MessagingTransport extends Messenger {
  attach(router: ChatRouter): void
  start(): Promise<void>
  stop(): Promise<void>
}
