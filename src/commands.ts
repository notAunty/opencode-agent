export const chatCommands = [
  { command: "agent", description: "Link an authorized Agent Session" },
  { command: "status", description: "Inspect pending work and recovery" },
  { command: "wake", description: "Schedule a wake with a saved prompt" },
  { command: "timers", description: "List scheduled timers" },
  { command: "cancel", description: "Cancel a timer by ID" },
  { command: "cancel_recovery", description: "Cancel usage-reset recovery" },
  { command: "stop", description: "Interrupt the agent; keep future timers" },
  { command: "retry", description: "Retry paused prompt admission" },
  { command: "unlink", description: "Unlink this conversation" },
  { command: "help", description: "List chat commands" },
] as const

export async function registerTelegramCommands(token: string, request: typeof fetch = fetch): Promise<void> {
  try {
    const response = await request(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: chatCommands, scope: { type: "default" }, language_code: "" }),
      signal: AbortSignal.timeout(10_000), redirect: "error",
    })
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error("registration failed")
  } catch {
    // Transport errors may contain the bot token embedded in the request URL
    throw new Error("Telegram command menu registration failed; existing menu and chat handling are unchanged")
  }
}
