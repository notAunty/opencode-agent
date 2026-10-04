import { randomUUID } from "node:crypto"
import { z } from "zod"
import { atomicWrite, godID, readJSON } from "./files.js"
import { Serial } from "./contracts.js"

export const timerSchema = z.object({
  id: z.string().uuid(), agentId: z.string().regex(godID), prompt: z.string().min(1).max(32_000),
  dueAt: z.number().finite(), status: z.enum(["scheduled", "admitted", "cancelled"]),
})
const document = z.object({ version: z.literal(1), timers: z.array(timerSchema) })
export type Timer = z.infer<typeof timerSchema>
export type TimerWhen = { delayMs: number; at?: never } | { at: string; delayMs?: never }

export class Timers {
  private lock = new Serial()
  constructor(private path: string, private now = Date.now) {}
  private async read(): Promise<Timer[]> {
    const value = await readJSON(this.path)
    return value === undefined ? [] : document.parse(value).timers
  }
  private save(timers: Timer[]): Promise<void> {
    return atomicWrite(this.path, JSON.stringify({ version: 1, timers }, null, 2) + "\n")
  }
  async create(agentId: string, prompt: string, when: TimerWhen): Promise<Timer> {
    const dueAt = when.delayMs !== undefined ? this.now() + when.delayMs : Date.parse(when.at)
    if (!Number.isFinite(dueAt) || (when.delayMs !== undefined && when.delayMs < 0)) throw new Error("Invalid timer time")
    if (when.at !== undefined && !/Z$|[+-]\d\d:\d\d$/.test(when.at)) throw new Error("Absolute time must include a timezone")
    const timer = timerSchema.parse({ id: randomUUID(), agentId, prompt, dueAt, status: "scheduled" })
    return this.lock.run(async () => { const timers = await this.read(); timers.push(timer); await this.save(timers); return timer })
  }
  list(agentId: string): Promise<Timer[]> {
    return this.lock.run(async () => (await this.read()).filter(t => t.agentId === agentId && t.status === "scheduled"))
  }
  cancel(agentId: string, id: string): Promise<boolean> {
    return this.lock.run(async () => {
      const timers = await this.read()
      const timer = timers.find(t => t.id === id && t.agentId === agentId && t.status === "scheduled")
      if (!timer) return false
      timer.status = "cancelled"
      await this.save(timers)
      return true
    })
  }
  tick(admit: (timer: Timer) => Promise<void>): Promise<void> {
    return this.lock.run(async () => {
      const timers = await this.read()
      const failures: unknown[] = []
      for (const timer of timers.filter(t => t.status === "scheduled" && t.dueAt <= this.now())) {
        // Persisted status follows durable inbox admission; a crash retries the same native message ID
        try { await admit(timer) } catch (error) { failures.push(error); continue }
        timer.status = "admitted"
        await this.save(timers)
      }
      if (failures.length) throw new AggregateError(failures, "Some timer admissions failed; other Agent Session timers were checked")
    })
  }
}
