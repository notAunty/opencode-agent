import { Service } from "@opencode/client/service"

try {
  const endpoint = await Service.discover()
  if (!endpoint) process.exit(1)
  const response = await fetch(new URL("/api/plugin?location%5Bdirectory%5D=%2Fworkspace", endpoint.url), {
    headers: Service.headers(endpoint), signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) process.exit(1)
  const plugins = await response.json()
  if (!plugins.data?.some(plugin => plugin.id === "octg" && plugin.state.status === "active")) process.exit(1)
} catch { process.exit(1) }
