import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { createGodInput } from "./service.js"
import { godID } from "./files.js"

const god = z.object({ godId: z.string().regex(godID) })
const unknown = z.unknown()

export const Octg = Rpc.define({
  id: "octg",
  methods: {
    create: { input: createGodInput, output: unknown },
    list: { input: z.void(), output: unknown },
    allowlist: { input: god.extend({ users: z.array(z.string()).min(1) }), output: z.void() },
    link: { input: god.extend({ conversation: z.string(), user: z.string() }), output: unknown },
    unlink: { input: god.extend({ conversation: z.string() }), output: z.void() },
    prompt: { input: god.extend({ text: z.string().min(1).max(32_000), key: z.string().optional() }), output: z.void() },
    status: { input: god, output: unknown },
    timer: { input: god.extend({ prompt: z.string().min(1).max(32_000), delayMs: z.number().nonnegative().optional(), at: z.string().optional() }), output: unknown },
    timers: { input: god, output: unknown },
    cancelTimer: { input: god.extend({ timerId: z.string().uuid() }), output: z.boolean() },
    cancelRecovery: { input: god, output: z.void() },
    retry: { input: god, output: z.void() },
    stop: { input: god, output: z.void() },
    compact: { input: god, output: z.void() },
  },
  events: {},
})
