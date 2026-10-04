# OpenCode Agent Sessions

Keep persistent OpenCode agents within reach from your terminal, the web, or messaging apps (eg. Telegram, Whatsapp, Google Chat and more!)

`opencode-agent` is an OpenCode v2 plugin. Each OpenCode session could be / is a main Agent, and background workers could be spawn by each Agent. OpenCode owns the conversation, model calls, permissions, background subagents, and compaction; the plugin adds chat routing, memory notes, wake timers, and notifications

For example, keep a `research` session and a `planning` session in the same project. Give each a different chat-user allowlist, continue their conversations in OpenCode, and schedule a saved prompt to wake either session later

## Quick start

Start with Telegram. You need OpenCode with a working model provider, Redis, a Telegram bot, and an HTTPS URL forwarding to the plugin's port `8787`

1. Install the plugin:
   ```sh
    opencode plugin add @notaunty/opencode-agent@latest
   ```
2. Create a directory for your agents, such as `~/agents`. Copy [examples/opencode.jsonc](examples/opencode.jsonc) into it as `opencode.jsonc`. Set `envFile` to `.env`, `chat.enabled` to `true`, and `chat.platforms` to `["telegram"]`, then open OpenCode in that directory
3. Put `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and `TELEGRAM_WEBHOOK_SECRET_TOKEN` in the project's `.env`, then reload the project plugin
4. [Register the bot's webhook](https://core.telegram.org/bots/api#setwebhook) as `https://your-host/chat/telegram`, with `secret_token` matching `TELEGRAM_WEBHOOK_SECRET_TOKEN`
5. From an authenticated OpenCode client in that project, create a session using your Telegram user ID:
   ```sh
   opencode api post /api/rpc/octg/create --data '{"input":{"id":"research","allowedUsers":["telegram:123"]}}'
   ```
6. Message your bot: `!agent research`, then send a normal message

Open the returned `sessionID` in CLI or web to continue the same conversation. Try `!wake 3600 Review the unfinished research notes` to schedule a wake in one hour

## Features

- **Multi-channel conversations** through the Chat SDK adapter ecosystem, with Telegram, Slack, and Discord as first-class integrations
- **Independent Agent Sessions** with separate conversations, task notes, timers, and user allowlists
- **Shared personality and memory** through project instructions and `MEMORY.md`, with short-term notes in `TASKS/<agentId>.md`
- **Native background workers and compaction** without a second agent runtime
- **Durable wake timers** checked every minute, queued when due, and cancellable by ID
- **API-error notifications** with optional bounded recovery after a provider supplies a usage-reset time
- **Attachments and artifacts** for incoming files and explicitly selected outgoing screenshots or documents

## Installation

Requires OpenCode V2 2.0.22 or later within V2

```sh
opencode plugin add @notaunty/opencode-agent@latest
```

Copy [examples/opencode.jsonc](examples/opencode.jsonc) into a directory for your agents as `opencode.jsonc`, then open OpenCode there. The example already points to `@notaunty/opencode-agent`

The configuration defines **Agent** as a primary OpenCode agent with **full tool permissions**. New Agent Sessions select it automatically. This permits shell commands, file edits, and other available tools without approval prompts; use it only in a trusted workspace

[Docker Compose](docker-compose.yml) is available for quick server deployment of OpenCode with persistent storage and Redis

## Chat commands

Use these commands in a linked **messaging app conversation**. They are not OpenCode TUI slash commands. In CLI/web, chat directly with the native session; use the owner RPC for session management

| Command | Purpose |
| --- | --- |
| `!agent <id>` | Link this conversation to an authorized Agent Session |
| `!status` | Inspect pending work and recovery status |
| `!wake <seconds\|ISO timestamp> <prompt>` | Schedule a wake; absolute timestamps need a timezone |
| `!timers` | List this session's timers |
| `!cancel <timer-id>` | Cancel one of this session's timers |
| `!cancel-recovery` | Cancel scheduled usage-reset recovery |
| `!stop` | Interrupt execution and clear staged input/recovery; future timers remain |
| `!retry` | Retry paused prompt admission, not completed actions |
| `!unlink` | Remove this conversation's link |

To register an existing primary session, include its `sessionID` in the create input. Registration preserves its selected native agent. Slack and Discord allowlist identities use `slack:<user-id>` and `discord:<user-id>`

## Configuration

### Environment variables

Provide credentials through the OpenCode server's environment. [.env.example](.env.example) lists the chat variables; Docker Compose loads them through `env_file`

For project-local chat credentials, set plugin option `"envFile": ".env"`. It reads the file as data, preserves inherited environment values, and does not configure native model-provider credentials. Reload the plugin after changing it

To load a project's `.env` for both chat and native model providers, launch a fresh OpenCode process with the included launcher:

```sh
cd ~/agents
node /path/to/installed/plugin/scripts/opencode-env.mjs --standalone
```

An already-running shared server cannot inherit a new client shell's environment. Keep `.env` out of version control and restrict its permissions. Exported credentials from a secret manager work too

### Chat integrations

Set `chat.enabled` to `true`, select your configured platforms in `chat.platforms`, and provide `REDIS_URL`. Chat is disabled by default. The listener defaults to `127.0.0.1:8787`

Expose webhook routes through HTTPS and register them with each platform yourself. The plugin does not register or delete webhooks. Each sender must still be in the target Agent Session's allowlist

#### Telegram

- Enable `telegram` in `chat.platforms`
- Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and `TELEGRAM_WEBHOOK_SECRET_TOKEN`
- Register `/chat/telegram` as the webhook, using the same secret token
- Uses webhook mode, not polling

#### Slack

- Enable `slack` in `chat.platforms`
- Set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`
- Configure event subscriptions to send events to `/chat/slack`

#### Discord

- Enable `discord` in `chat.platforms`
- Set `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_PUBLIC_KEY`
- Configure `/chat/discord` for interactions
- For ordinary messages, enable `chat.discordGateway` and the appropriate Discord intents

### Memory and timers

Agent Sessions share the project directory and `MEMORY.md`; each has its own `TASKS/<agentId>.md`. Bounded notes are included in model context and native compaction requests. The `octg_save_memory` tool saves these notes

Timers persist in `.octg/timers.json`. The plugin checks them every minute and queues saved prompts into the target session. `octg_wake` schedules a timer from the agent itself

Keep OpenCode and its project plugin active for unattended timers. Overdue timers are admitted when the plugin becomes active again

### Error recovery

API failures produce sanitized chat notifications. Optional `usageResetRecovery` is disabled by default; it uses a bounded future `Retry-After` value from HTTP 429 responses and is capped at three checks

Recovery asks the agent to inspect unfinished task notes rather than replay the failed prompt. It waits for a fresh reset failure between successful admissions. New user activity or `!cancel-recovery` cancels it

## Permissions and limitations

- **Agent has full permissions.** Chat authorization limits who can prompt a session, not what that agent can do. Restrict native permissions yourself if needed
- Linked groups and channels expose replies to everyone who can read them
- Shared files and browser profiles are not isolation between untrusted agents
- One process owns a project's scheduler; timers do not run when the plugin is inactive
- Platform posts can duplicate after a crash. Replies already compacted during downtime may be missed
- Chat does not grant native permissions or answer native questions; handle any remaining requests in CLI/web
- Browser automation is optional. [examples/browser.jsonc](examples/browser.jsonc) supplies a disabled Playwriter connection; no extension or relay is activated automatically

Use `octg_send_file` to send an explicitly selected project artifact to linked conversations. The owner RPC contract is exported as `@notaunty/opencode-agent/rpc`; see [src/rpc.ts](src/rpc.ts) for session management and timer methods

See [docs.md](docs.md) for architecture and operational details, and [AGENTS.md](AGENTS.md) for development boundaries
