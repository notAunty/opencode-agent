# OCTG V2

A clean-room OpenCode V2 plugin for persistent Agent Sessions through OpenCode CLI, web, and Vercel Chat SDK

## Requirements

- Multiple independent primary sessions in one shared project directory
- Shared personality and `MEMORY.md`; isolated short-term notes in `TASKS/<agentId>.md`
- Explicit cross-channel linking and a mandatory per-session user allowlist
- Slack, Telegram, and Discord through official Chat SDK adapters
- Native background subagents and automatic compaction, not a second agent runtime
- Durable JSON timers checked every minute to wake an Agent Session with a saved prompt
- Graceful API-error notifications and optional bounded recovery at verified usage-reset times

See [docs.md](docs.md) for the agreed requirements and architecture

## Deployment

Install and build this package in your deployment environment, then merge `examples/opencode.jsonc` into that project's OpenCode V2 configuration. Set the plugin `package` to this package's absolute directory. The native primary agent profile is `main`

Chat is disabled by default. To enable it, provide the environment variables listed in `.env.example`, a durable Redis instance, and set `chat.enabled` to `true`. Enable only the platforms you have configured. Expose `/chat/slack`, `/chat/telegram`, and `/chat/discord` through your HTTPS ingress and register their webhooks explicitly. The plugin never registers or deletes platform webhooks. Discord ordinary messages additionally require `discordGateway: true` and the platform's appropriate intents

From an authenticated OpenCode client in the configured project, create an Agent Session:

```sh
opencode api post /api/rpc/octg/create --data '{"input":{"id":"research","allowedUsers":["telegram:123"]}}'
```

Open the returned `sessionID` in the CLI or web session picker. Alternatively, register an existing primary session by including its `sessionID` in the create input. Chat users first send `!agent research`; they must already be in that session's allowlist

Chat commands: `!agent <id>`, `!status`, `!wake <seconds|ISO timestamp> <prompt>`, `!timers`, `!cancel <timer-id>`, `!cancel-recovery`, `!stop`, `!retry`, `!unlink`. `!stop` leaves future timers scheduled

Native plugin tools: `octg_save_memory`, `octg_wake`, `octg_send_file`. The last sends an explicitly selected screenshot/artifact to linked conversations and should require owner approval. Permissions and questions are answered in the native CLI/web, never automatically from chat

The typed owner RPC contract is exported as `octg/rpc`. Methods include registry management, `prompt`, `status`, timers, `stop`, and `compact`; session-scoped inputs use `agentId`

## Verification

All development verification runs in disposable containers without real credentials, host mounts, or bot connections:

```sh
docker build -t octg-v2-test .
docker run --rm --network none octg-v2-test
docker run --rm --network none octg-v2-test timeout --kill-after=2s 60s node dist/test/native.js
```

The build checks types, runs synthetic tests, and compiles the plugin. The native fixture exercises OpenCode V2's embedded SDK without a host service or model calls

## Browser access

Prefer OpenCode V2's native browser tools when available. `examples/browser.jsonc` shows a disabled Playwriter MCP alternative for an existing Chrome profile. Neither browser access nor an extension/relay is activated by this repository. See `docs.md` for security and lifecycle limitations

## Provenance

The `v2` seed contains only `README.md`, `AGENTS.md`, and `docs.md`. No V1 code, dependencies, configuration, or runtime data is reused. `main` remains unchanged
