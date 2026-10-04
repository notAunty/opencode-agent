export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: Json): Promise<void>
}

export interface FileInput { uri: string; mime?: string; filename?: string }
export interface NativeMessage {
  id: string
  type: string
  time?: { created: number; completed?: number }
  finish?: string
  content?: readonly { type: string; text?: string }[]
  error?: { type: string; status?: number }
}
export interface Sessions {
  create(input: { id: string; title: string; agent: string }): Promise<{ id: string }>
  get(sessionID: string): Promise<{ id: string; parentID?: string }>
  prompt(input: { sessionID: string; id: string; text: string; files?: FileInput[] }): Promise<void>
  context(sessionID: string): Promise<readonly NativeMessage[]>
  compact(sessionID: string): Promise<void>
  interrupt(sessionID: string): Promise<void>
  approvals?(sessionID: string): Promise<readonly { id: string }[]>
}
export interface Messenger { post(conversation: string, text: string, file?: FileInput): Promise<void> }

export interface AgentSession {
  id: string
  sessionID: string
  allowedUsers: string[]
  conversations: { id: string; linkedBy: string }[]
  createdAt: number
  revision: number
}
export interface Pending {
  id: string
  godId: string
  text: string
  files: FileInput[]
  dueAt: number
  attempts: number
  actor?: string
}
export interface Notice {
  id: string
  godId: string
  conversation: string
  text: string
  dueAt: number
  attempts: number
  file?: FileInput
}
export interface Recovery { godId: string; dueAt: number; revision: number; attempts: number; awaitingResult?: boolean }
export interface State {
  version: 1
  gods: AgentSession[]
  pending: Pending[]
  notices: Notice[]
  seen: Record<string, number>
  recoveries: Recovery[]
}

export function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json }

export class Serial {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work)
    this.tail = next.catch(() => {})
    return next
  }
}
