import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { createAgentInput, agentSessionSchema, statusSchema } from "./service.js"
import { godID } from "./files.js"
import { timerSchema } from "./timers.js"

const agent = z.object({ agentId: z.string().regex(godID) })

export const Octg = Rpc.define({
  id: "octg",
  methods: {
    create: { input: createAgentInput, output: agentSessionSchema },
    list: { input: z.void(), output: z.array(agentSessionSchema) },
    allowlist: { input: agent.extend({ users: z.array(z.string()).min(1) }), output: z.void() },
    link: { input: agent.extend({ conversation: z.string(), user: z.string() }), output: agentSessionSchema },
    unlink: { input: agent.extend({ conversation: z.string() }), output: z.void() },
    prompt: { input: agent.extend({ text: z.string().min(1).max(32_000), key: z.string().optional() }), output: z.void() },
    status: { input: agent, output: statusSchema },
    timer: { input: agent.extend({ prompt: z.string().min(1).max(32_000), delayMs: z.number().nonnegative().optional(), at: z.string().optional() }), output: timerSchema },
    timers: { input: agent, output: z.array(timerSchema) },
    cancelTimer: { input: agent.extend({ timerId: z.string().uuid() }), output: z.boolean() },
    cancelRecovery: { input: agent, output: z.void() },
    retry: { input: agent, output: z.void() },
    stop: { input: agent, output: z.void() },
    compact: { input: agent, output: z.void() },
  },
  events: {},
})
