import { createHash } from "node:crypto"

export const traceRef = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 16)

export function trace(stage: string, key: string, detail: Record<string, string | number | boolean> = {}): void {
  console.error(JSON.stringify({ component: "octg", stage, ref: traceRef(key), ...detail }))
}

export function errorFields(error: unknown): Record<string, string | number> {
  const value = error as { name?: string; code?: string; status?: number; data?: { error?: string } } | undefined
  const names = ["AbortError", "TimeoutError", "ZodError", "TypeError", "Error"]
  const codes = ["slack_webapi_platform_error", "slack_webapi_request_error", "slack_webapi_rate_limited_error", "invalid_auth", "missing_scope", "not_in_channel", "channel_not_found", "ratelimited", "token_revoked", "account_inactive", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ENOENT", "EACCES", "ENOSPC"]
  const code = value?.data?.error ?? value?.code
  return { error: names.includes(value?.name ?? "") ? value!.name! : "UnknownError",
    ...(code && codes.includes(code) ? { code } : {}),
    ...(typeof value?.status === "number" ? { status: value.status } : {}) }
}
