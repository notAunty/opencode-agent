export function errorNotice(status?: number, type?: string): string {
  if (status === 401 || status === 403) return "Provider access failed. Please check credentials or permissions in OpenCode"
  if (status === 429 || type?.includes("rate") || type?.includes("quota")) return "Provider usage limit reached. Work is paused; retry later or enable verified-reset recovery"
  if (status && status >= 500) return "The provider is temporarily unavailable. OpenCode will apply its retry policy; check the session before retrying work"
  return "OpenCode could not complete this request. Check the session in CLI/web for details; completed actions have not been replayed"
}

export function resetTime(headers: Headers, now: number): number | undefined {
  const retry = headers.get("retry-after")
  if (retry) {
    const value = /^\d+(\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry)
    if (Number.isFinite(value) && value > now && value <= now + 7 * 86_400_000) return value
  }
  return undefined
}
