import { SlackAdapter, SlackFormatConverter, type SlackAdapterConfig } from "@chat-adapter/slack"
import type { AdapterPostableMessage, WebhookOptions } from "chat"
import { errorFields, trace } from "./diagnostics.js"

class NoticeFormatConverter extends SlackFormatConverter {
  override toSlackPayload(message: AdapterPostableMessage): ReturnType<SlackFormatConverter["toSlackPayload"]> & { mrkdwn?: boolean } {
    if (typeof message === "object" && "raw" in message) return { text: message.raw, mrkdwn: false }
    return super.toSlackPayload(message)
  }
}

class SocketSlackAdapter extends SlackAdapter {
  protected override readonly formatConverter = new NoticeFormatConverter()
  constructor(config: SlackAdapterConfig, private waitUntil?: (promise: Promise<unknown>) => void) { super(config) }
  protected override async resolveMessageMentions(message: AdapterPostableMessage, threadId: string): Promise<AdapterPostableMessage> {
    // Notices are literal text, not instructions to resolve usernames or render platform markup.
    return typeof message === "object" && "raw" in message ? message : super.resolveMessageMentions(message, threadId)
  }
  protected override async routeSocketEvent(body: Record<string, unknown>, eventType: string,
    ack: (response?: Record<string, unknown>) => Promise<void>, options?: WebhookOptions, retryNum?: number): Promise<void> {
    const event = body.event as { ts?: string } | undefined
    const key = event?.ts ?? (typeof body.trigger_id === "string" ? body.trigger_id : "slack")
    // SDK 4.41.1 awaits ack outside its handler catch; a broken socket must not discard durable admission.
    await super.routeSocketEvent(body, eventType, async response => {
      try { await ack(response); trace("slack.acknowledged", key) }
      catch (error) { trace("slack.ack.failed", key, errorFields(error)) }
    }, this.waitUntil ? { ...options, waitUntil: promise => { options?.waitUntil?.(promise); this.waitUntil!(promise) } } : options, retryNum)
  }
}

export function createSocketSlackAdapter(config: SlackAdapterConfig, waitUntil?: (promise: Promise<unknown>) => void): SlackAdapter {
  return new SocketSlackAdapter({ ...config, mode: "socket" }, waitUntil)
}
