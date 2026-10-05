import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { godID } from "./files.js"
import { errorNotice } from "./errors.js"
import { errorFields, trace, traceRef } from "./diagnostics.js"
import { json, Serial, type FileInput, type AgentSession, type Messenger, type Sessions, type State, type Storage } from "./contracts.js"

const identity = z.string().regex(/^(telegram|slack|discord):[^\s:]+$/)
const binding = z.object({ id: z.string().min(1), linkedBy: identity })
const file = z.object({ uri: z.string(), mime: z.string().optional(), filename: z.string().optional() })
export const agentSessionSchema = z.object({ id: z.string().regex(godID), sessionID: z.string().startsWith("ses"),
  allowedUsers: z.array(identity).min(1), conversations: z.array(binding), createdAt: z.number(), revision: z.number() })
export const statusSchema = z.object({ id: z.string(), sessionID: z.string(), pending: z.array(z.object({ id: z.string(), attempts: z.number(), dueAt: z.number(), paused: z.boolean() })),
  pendingNotices: z.number(), recovery: z.array(z.object({ agentId: z.string(), dueAt: z.number(), revision: z.number(), attempts: z.number(), awaitingResult: z.boolean().optional() })) })
const stateSchema = z.object({
  version: z.literal(1),
  gods: z.array(agentSessionSchema),
  pending: z.array(z.object({ id: z.string(), godId: z.string(), text: z.string(), files: z.array(file),
    dueAt: z.number(), attempts: z.number(), actor: z.string().optional() })),
  notices: z.array(z.object({ id: z.string(), godId: z.string(), conversation: z.string(), text: z.string(), dueAt: z.number(), attempts: z.number(), file: file.optional() })),
  seen: z.record(z.string(), z.number()),
  recoveries: z.array(z.object({ godId: z.string(), dueAt: z.number(), revision: z.number(), attempts: z.number(), awaitingResult: z.boolean().optional() })),
})
export const createAgentInput = z.object({ id: z.string().regex(godID), allowedUsers: z.array(identity).min(1), sessionID: z.string().startsWith("ses").optional() })
export const nativeID = (prefix: "msg" | "ses", key: string): string => `${prefix}_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`

export class AgentSessions {
  // External requests must not block durable staging or re-entering session hooks
  private lock = new Serial()
  private dispatch = new Serial()
  private delivery = new Serial()
  constructor(private storage: Storage, private sessions: Sessions, private messenger: Messenger,
    private now = Date.now, private recoveryEnabled = false, private namespace = "octg") {}
  private async read(): Promise<State> {
    const value = await this.storage.get("state/v1")
    return value === undefined ? { version: 1, gods: [], pending: [], notices: [], seen: {}, recoveries: [] } : stateSchema.parse(value)
  }
  private async save(state: State): Promise<void> {
    const keys = Object.keys(state.seen)
    if (keys.length > 10_000) {
      keys.sort((a, b) => state.seen[a]! - state.seen[b]!).slice(0, keys.length - 10_000).forEach(key => delete state.seen[key])
    }
    await this.storage.set("state/v1", json(state))
  }
  private find(state: State, id: string, actor?: string): AgentSession {
    const god = state.gods.find(g => g.id === id)
    if (!god || (actor !== undefined && !god.allowedUsers.includes(actor))) throw new Error("Agent Session unavailable or access denied")
    return god
  }
  async get(id: string, actor?: string): Promise<AgentSession> { return this.find(await this.read(), id, actor) }
  async list(): Promise<AgentSession[]> { return (await this.read()).gods }
  async bySession(sessionID: string): Promise<AgentSession | undefined> { return (await this.read()).gods.find(g => g.sessionID === sessionID) }
  async byConversation(conversation: string, actor: string): Promise<AgentSession> {
    const state = await this.read()
    const god = state.gods.find(g => g.conversations.some(c => c.id === conversation))
    if (!god) throw new Error("Conversation is not linked. Use !agent <id> after the owner authorizes you")
    return this.find(state, god.id, actor)
  }
  create(input: z.infer<typeof createAgentInput>): Promise<AgentSession> {
    input = createAgentInput.parse(input)
    return this.lock.run(async () => {
      const state = await this.read()
      if (state.gods.some(g => g.id === input.id)) throw new Error("Agent ID already exists")
      if (input.sessionID && state.gods.some(g => g.sessionID === input.sessionID)) throw new Error("Session already belongs to an Agent Session")
      const sessionID = input.sessionID ?? nativeID("ses", `god:${this.namespace}:${input.id}`)
      if (input.sessionID) {
        const session = await this.sessions.get(sessionID)
        if (session.parentID) throw new Error("Register a primary native session, not a child task session")
      }
      else {
        // A failed registry write can be recovered without creating an orphan second session
        try { await this.sessions.get(sessionID) }
        catch { await this.sessions.create({ id: sessionID, title: `Agent Session: ${input.id}`, agent: "Agent" }) }
      }
      const god: AgentSession = { id: input.id, sessionID, allowedUsers: [...new Set(input.allowedUsers)], conversations: [], createdAt: this.now(), revision: 0 }
      state.gods.push(god)
      await this.save(state)
      return god
    })
  }
  setAllowlist(id: string, allowedUsers: string[]): Promise<void> {
    z.array(identity).min(1).parse(allowedUsers)
    return this.lock.run(async () => {
      const state = await this.read(); const god = this.find(state, id)
      god.allowedUsers = [...new Set(allowedUsers)]
      god.conversations = god.conversations.filter(c => god.allowedUsers.includes(c.linkedBy))
      await this.save(state)
    })
  }
  link(id: string, conversation: string, actor: string): Promise<AgentSession> {
    identity.parse(actor)
    if (conversation.split(":")[0] !== actor.split(":")[0]) throw new Error("Conversation and user platform must match")
    return this.lock.run(async () => {
      const state = await this.read(); const god = this.find(state, id, actor)
      const previous = state.gods.find(g => g.conversations.some(c => c.id === conversation))
      if (previous && previous.id !== id) this.find(state, previous.id, actor)
      for (const g of state.gods) g.conversations = g.conversations.filter(c => c.id !== conversation)
      god.conversations.push({ id: conversation, linkedBy: actor })
      await this.save(state)
      return god
    })
  }
  unlink(id: string, conversation: string, actor?: string): Promise<void> {
    return this.lock.run(async () => {
      const state = await this.read(); const god = this.find(state, id, actor)
      god.conversations = god.conversations.filter(c => c.id !== conversation)
      await this.save(state)
    })
  }
  accept(id: string, text: string, key: string = randomUUID(), actor?: string, files: FileInput[] = []): Promise<{ id: string; duplicate: boolean }> {
    if (text.length > 32_000 || files.length > 8) throw new Error("Prompt is too large")
    return this.lock.run(async () => {
      const state = await this.read(); const god = this.find(state, id, actor)
      const messageID = nativeID("msg", `${this.namespace}:${id}:${key}`)
      if (state.seen[`input:${messageID}`] || state.pending.some(p => p.id === messageID)) return { id: messageID, duplicate: true }
      if (state.pending.filter(p => p.godId === id).length >= 100) throw new Error("Agent inbox is full; retry after queued work drains")
      god.revision++
      state.recoveries = state.recoveries.filter(r => r.godId !== id)
      state.pending.push({ id: messageID, godId: id, text, files, dueAt: this.now(), attempts: 0, ...(actor ? { actor } : {}) })
      await this.save(state)
      trace("inbox.saved", messageID)
      return { id: messageID, duplicate: false }
    })
  }
  async admitTimer(id: string, timerID: string, text: string): Promise<void> {
    // Native admission, not the local staging queue, is the timer's durable completion boundary
    const god = await this.get(id)
    await this.sessions.prompt({ sessionID: god.sessionID, id: nativeID("msg", `timer:${this.namespace}:${id}:${timerID}`), text: `[Scheduled wake ${timerID}]\n${text}` })
  }
  taskOutcome(id: string, childSessionID: string, outcome: string, updated: number): Promise<void> {
    return this.lock.run(async () => {
      const state = await this.read(); const god = this.find(state, id)
      this.notice(state, god, `Background task ${childSessionID}: ${outcome}. Details remain in the native OpenCode child session`, `child:${childSessionID}:${updated}:${outcome}`)
      await this.save(state)
    })
  }
  sendFile(id: string, file: FileInput, text: string): Promise<void> {
    return this.lock.run(async () => {
      const state = await this.read(); const god = this.find(state, id)
      if (!god.conversations.length) throw new Error("Agent Session has no linked Chat destination")
      this.notice(state, god, text, `file:${randomUUID()}`, file)
      await this.save(state)
    })
  }
  private notice(state: State, god: AgentSession, text: string, key: string, file?: FileInput): void {
    for (const conversation of god.conversations) {
      if (!god.allowedUsers.includes(conversation.linkedBy)) continue
      const id = nativeID("msg", `${this.namespace}:${god.id}:${conversation.id}:${key}`)
      if (state.seen[`notice:${id}`] || state.notices.some(n => n.id === id)) continue
      state.notices.push({ id, godId: god.id, conversation: conversation.id, text, dueAt: this.now(), attempts: 0, ...(file ? { file } : {}) })
      state.seen[`notice:${id}`] = this.now()
    }
  }
  failure(sessionID: string, status?: number, type?: string, resetAt?: number): Promise<void> {
    return this.lock.run(async () => {
      const state = await this.read(); const god = state.gods.find(g => g.sessionID === sessionID)
      if (!god) return
      this.notice(state, god, errorNotice(status, type), `error:${status}:${type}:${Math.floor(this.now() / 300_000)}`)
      if (this.recoveryEnabled && status === 429 && resetAt && resetAt > this.now()) {
        const recovery = state.recoveries.find(r => r.godId === god.id && r.revision === god.revision)
        if (recovery) { recovery.dueAt = Math.max(recovery.dueAt, resetAt, this.now() + 300_000); recovery.awaitingResult = false }
        else state.recoveries.push({ godId: god.id, revision: god.revision, dueAt: resetAt, attempts: 0 })
        this.notice(state, god, `A bounded recovery check is scheduled after ${new Date(resetAt).toISOString()}`, `reset:${god.revision}`)
      }
      await this.save(state)
    })
  }
  cancelRecovery(id: string, actor?: string): Promise<void> {
    return this.lock.run(async () => { const state = await this.read(); this.find(state, id, actor); state.recoveries = state.recoveries.filter(r => r.godId !== id); await this.save(state) })
  }
  async stop(id: string, actor?: string): Promise<void> {
    const god = await this.get(id, actor)
    await this.cancelRecovery(id, actor)
    await this.lock.run(async () => { const state = await this.read(); this.find(state, id, actor); state.pending = state.pending.filter(p => p.godId !== id); await this.save(state) })
    await this.sessions.interrupt(god.sessionID)
  }
  async status(id: string, actor?: string): Promise<z.infer<typeof statusSchema>> {
    const state = await this.read(); const god = this.find(state, id, actor)
    return { id: god.id, sessionID: god.sessionID, pending: state.pending.filter(p => p.godId === id).map(p => ({ id: p.id, attempts: p.attempts, dueAt: p.dueAt, paused: p.attempts >= 5 })),
      pendingNotices: state.notices.filter(n => n.godId === id).length, recovery: state.recoveries.filter(r => r.godId === id).map(({ godId, ...recovery }) => ({ agentId: godId, ...recovery })) }
  }
  retry(id: string, actor?: string): Promise<void> {
    return this.lock.run(async () => { const state = await this.read(); this.find(state, id, actor); state.pending.filter(p => p.godId === id).forEach(p => { p.attempts = 0; p.dueAt = this.now() }); await this.save(state) })
  }
  localActivity(sessionID: string): Promise<void> {
    return this.lock.run(async () => {
      const state = await this.read(); const god = state.gods.find(g => g.sessionID === sessionID)
      if (!god) return
      god.revision++
      state.recoveries = state.recoveries.filter(r => r.godId !== god.id)
      await this.save(state)
    })
  }
  async tick(): Promise<void> {
    await Promise.all([this.admit(), this.deliver()])
  }
  admit(): Promise<void> {
    return this.dispatch.run(async () => {
      for (const candidate of (await this.read()).pending) {
        const work = await this.lock.run(async () => {
          const state = await this.read()
          const pending = state.pending.find(p => p.id === candidate.id)
          if (!pending || pending.dueAt > this.now() || pending.attempts >= 5) return
          const god = state.gods.find(g => g.id === pending.godId)
          if (!god || (pending.actor && !god.allowedUsers.includes(pending.actor))) {
            state.pending = state.pending.filter(p => p.id !== pending.id)
            await this.save(state)
            trace("inbox.revoked", pending.id)
            return
          }
          if (state.pending.find(p => p.godId === pending.godId)?.id !== pending.id) return
          return { pending, god }
        })
        if (!work) continue
        const { pending, god } = work
        let failed = false
        trace("native.admission.started", pending.id, { attempt: pending.attempts + 1, sessionRef: traceRef(god.sessionID) })
        try {
          await this.sessions.prompt({ sessionID: god.sessionID, id: pending.id, text: pending.text, files: pending.files })
          trace("native.admitted", pending.id)
        } catch (error) {
          failed = true
          trace("native.admission.uncertain", pending.id, errorFields(error))
        }
        await this.lock.run(async () => {
          const state = await this.read()
          const current = state.pending.find(p => p.id === pending.id)
          if (!failed) {
            state.pending = state.pending.filter(p => p.id !== pending.id)
            state.seen[`input:${pending.id}`] = this.now()
          } else if (current) {
            current.attempts++; current.dueAt = this.now() + Math.min(60_000, 1000 * 2 ** current.attempts)
            const agent = this.find(state, god.id)
            this.notice(state, agent, "Native admission was not confirmed. Your message remains saved with the same ID; use !status to inspect it. It may already be queued", `admission:${pending.id}`)
            if (current.attempts >= 5) trace("native.admission.paused", pending.id)
          }
          await this.save(state)
        })
      }
      for (const recovery of (await this.read()).recoveries) {
        if (recovery.dueAt > this.now() || recovery.attempts >= 3 || recovery.awaitingResult) continue
        const god = (await this.read()).gods.find(g => g.id === recovery.godId && g.revision === recovery.revision)
        if (!god) continue
        let admitted = false
        try {
          await this.sessions.prompt({ sessionID: god.sessionID, id: nativeID("msg", `recovery:${this.namespace}:${god.id}:${recovery.revision}:${recovery.attempts}`),
            text: "Provider reset recovery check: inspect your current TASKS notes and completed actions first. Continue only unfinished, still-requested work. Do not replay completed side effects" })
          admitted = true
        } catch {}
        await this.lock.run(async () => {
          const state = await this.read()
          const current = state.recoveries.find(r => r.godId === recovery.godId && r.revision === recovery.revision && r.attempts === recovery.attempts)
          if (!current) return
          current.attempts++
          if (admitted) current.awaitingResult = true
          else current.dueAt = this.now() + 60_000
          await this.save(state)
        })
      }
    })
  }
  private deliver(): Promise<void> {
    return this.delivery.run(async () => {
      for (const notice of (await this.read()).notices) {
        if (notice.dueAt > this.now()) continue
        const god = (await this.read()).gods.find(g => g.id === notice.godId)
        if (!god?.conversations.some(c => c.id === notice.conversation && god.allowedUsers.includes(c.linkedBy))) {
          await this.lock.run(async () => {
            const state = await this.read(); state.notices = state.notices.filter(n => n.id !== notice.id); await this.save(state)
          })
          continue
        }
        let delivered = false
        try { await this.messenger.post(notice.conversation, notice.text, notice.file); delivered = true }
        catch (error) { trace("outbox.delivery.failed", notice.id, errorFields(error)) }
        await this.lock.run(async () => {
          const state = await this.read()
          const current = state.notices.find(n => n.id === notice.id)
          if (!current) return
          if (delivered) state.notices = state.notices.filter(n => n.id !== notice.id)
          else { current.attempts++; current.dueAt = this.now() + Math.min(300_000, 1000 * 2 ** Math.min(current.attempts, 10)) }
          await this.save(state)
        })
      }
    })
  }
  async reconcile(): Promise<void> {
    for (const god of await this.list()) {
      let messages
      try { messages = await this.sessions.context(god.sessionID) }
      catch { await this.failure(god.sessionID); continue }
      const approvals = await this.sessions.approvals?.(god.sessionID).catch(() => []) ?? []
      await this.lock.run(async () => {
        const state = await this.read(); const current = this.find(state, god.id)
        for (const approval of approvals) this.notice(state, current, "Agent is waiting for approval. Review it in the native OpenCode CLI or web session; chat cannot grant permissions", `approval:${approval.id}`)
        for (const message of messages) {
          if (message.type === "user" && state.pending.some(p => p.id === message.id && p.godId === god.id)) {
            state.pending = state.pending.filter(p => p.id !== message.id)
            state.seen[`input:${message.id}`] = this.now()
            trace("native.admission.confirmed_by_context", message.id)
          }
          if (message.type === "user" && state.seen[`input:${message.id}`] && !state.seen[`observed:${message.id}`]) {
            trace("native.context.observed", message.id, { sessionRef: traceRef(god.sessionID) })
            state.seen[`observed:${message.id}`] = this.now()
          }
          if (message.type !== "assistant" || !message.time?.completed || message.time.created < current.createdAt) continue
          if (state.seen[`processed:${message.id}`]) continue
          state.seen[`processed:${message.id}`] = this.now()
          trace("native.assistant.completed", message.id, { failed: Boolean(message.error), sessionRef: traceRef(god.sessionID) })
          if (message.error) this.notice(state, current, errorNotice(message.error.status, message.error.type), `terminal:${message.id}`)
          else if (message.finish !== "tool-calls") {
            const text = message.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("\n").trim()
            if (text) this.notice(state, current, text, `reply:${message.id}`)
            state.recoveries = state.recoveries.filter(r => r.godId !== current.id)
          }
        }
        await this.save(state)
      })
    }
  }
}
