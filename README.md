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

The typed owner RPC contract is exported as `@notaunty/octg/rpc`. Methods include registry management, `prompt`, `status`, timers, `stop`, and `compact`; session-scoped inputs use `agentId`

## Distribution

The package is prepared as `@notaunty/octg` for GitHub Packages. In your release environment:

```sh
npm ci
npm run dist
```

This checks types, builds, and creates `notaunty-octg-2.0.0.tgz` locally without publishing. The package allowlist includes compiled plugin code, launchers, examples, and documentation, not credentials or runtime data

To publish deliberately, authenticate using a GitHub personal access token (classic) with `write:packages`:

```sh
npm login --scope=@notaunty --auth-type=legacy --registry=https://npm.pkg.github.com
npm run publish:github
```

Publishing runs verification first. New GitHub packages default to private; confirm package visibility and access after publication. Installation requires `read:packages` credentials and the `@notaunty` registry mapping for the OpenCode server account. Use `"package": "@notaunty/octg@2.0.0"` in plugin configuration after publishing. Increment the package version before subsequent releases

## Server deployment

`Dockerfile` now defaults to the running OpenCode V2 service, not tests. `docker-compose.yml` includes Redis on Alpine with append-only persistence. OpenCode runs as a non-root user; workspace, native data/configuration, and Redis data use named volumes. No host project or secret directory is mounted

Create a deployment `.env` from `.env.example`, fill only the credentials you need, then run:

```sh
docker compose up -d --build
```

Compose's `env_file` injects `.env` values into the OpenCode process; `REDIS_URL` is set to the internal Redis service. Redis is not published. OpenCode and webhook ports are published on host loopback only. Expose only webhook routes through your HTTPS ingress; do not expose the owner API without authentication

The image seeds `/workspace/opencode.json` with chat disabled. Edit that file inside the container to enable your selected platforms, then restart the service. The workspace volume preserves configuration and memory. Image upgrades do not replace existing workspace configuration

```sh
docker compose exec opencode opencode api get '/api/plugin?location[directory]=/workspace'
docker compose restart opencode
```

The authenticated health check activates the `/workspace` plugin, so timers run without an attached interactive client

## Laptop environment

Keep your dedicated agent directory separate from the installed plugin directory. In that agent directory, merge the example configuration and use the plugin's absolute package path

To load that directory's `.env` before launching OpenCode, use the included launcher after building the package:

```sh
cd ~/agents
node /absolute/path/to/octg/scripts/opencode-env.mjs --standalone
```

You can use a shell function for the usual `opencode` command without editing OpenCode's global configuration:

```sh
opencode() { node /absolute/path/to/octg/scripts/opencode-env.mjs --standalone "$@"; }
```

This parses `.env` as data, not executable shell code. Existing environment variables win. `--standalone` ensures a fresh private server inherits those values; an already-running shared server would not inherit a new client shell's environment. Use this function for interactive usage, not service-management commands

Alternatively, plugin options `"envFile": ".env"` load chat credentials directly from the current project directory, even in a shared OpenCode service. This is opt-in, project-scoped, and does not mutate global `process.env` or configure model-provider credentials. The launcher loads all variables into the child OpenCode process instead. Changes require restarting the standalone/container process or reloading the project plugin, respectively

Keep `.env` out of version control and restrict its file permissions. The example launcher/function is not installed into your shell automatically

## Verification

All development verification runs in disposable containers without real credentials, host mounts, or bot connections:

```sh
docker build --target test -t octg-v2-test .
docker run --rm --network none octg-v2-test
docker run --rm --network none octg-v2-test timeout --kill-after=2s 60s node dist/test/native.js
```

The build checks types, runs synthetic tests, and compiles the plugin. The native fixture exercises OpenCode V2's embedded SDK without a host service or model calls

## Browser access

Prefer OpenCode V2's native browser tools when available. `examples/browser.jsonc` shows a disabled Playwriter MCP alternative for an existing Chrome profile. Neither browser access nor an extension/relay is activated by this repository. See `docs.md` for security and lifecycle limitations

## Provenance

The `v2` seed contains only `README.md`, `AGENTS.md`, and `docs.md`. No V1 code, dependencies, configuration, or runtime data is reused. `main` remains unchanged
