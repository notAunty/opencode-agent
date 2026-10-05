# OpenCode Agent Sessions

Keep persistent OpenCode agents within reach from your terminal, the web, or messaging apps (eg. Telegram, Whatsapp, Google Chat and more!)

`opencode-agent` is an OpenCode v2 plugin. Each OpenCode session could be / is a main Agent, and background workers could be spawn by each Agent. OpenCode owns the conversation, model calls, permissions, background subagents, and compaction; the plugin adds chat routing, memory notes, wake timers, and notifications

For example, keep a `research` session and a `planning` session in the same project. Give each a different chat-user allowlist, continue their conversations in OpenCode, and schedule a saved prompt to wake either session later

## Quick start

Start with Telegram. You need OpenCode with a working model provider and a Telegram bot. Telegraf long polling needs neither Redis nor a public HTTPS endpoint

1. Install the plugin:
   ```sh
    opencode plugin add @notaunty/opencode-agent@latest
   ```
2. Create a directory for your agents, such as `~/agents`. Copy [examples/opencode.jsonc](examples/opencode.jsonc) into it as `opencode.jsonc`. Set `envFile` to `.env`, `chat.enabled` to `true`, and `chat.platforms` to `["telegram"]`, then open OpenCode in that directory
3. Put `TELEGRAM_BOT_TOKEN` in the project's `.env`, then reload the project plugin
4. Use a bot without an existing webhook; polling refuses to change one. Only one process may poll the same bot
5. From an authenticated OpenCode client in that project, create a session using your Telegram user ID:
   ```sh
   LOCATION="location%5Bdirectory%5D=$(node -p 'encodeURIComponent(process.cwd())')"
   opencode api post "/api/rpc/octg/create?$LOCATION" --data '{"input":{"id":"research","allowedUsers":["telegram:123"]}}'
   opencode api post "/api/rpc/octg/list?$LOCATION" --data '{}'
   ```
   Replace `123` with your numeric Telegram user ID. Check `allowedUsers` in the list output; change it through the [`allowlist` RPC](#owner-management-api). CLI/RPC interface exists; no dedicated settings UI yet
6. Message your bot: `/agent research`, then send a normal message

Open the returned `sessionID` in CLI or web to continue the same conversation. Try `/wake 3600 Review the unfinished research notes` to schedule a wake in one hour

## Features

- **Multi-channel conversations** through the Chat SDK adapter ecosystem, with Telegram, Slack, and Discord as first-class integrations
- **Independent Agent Sessions** with separate conversations, task notes, timers, and user allowlists
- **Shared personality and memory** through project instructions and `MEMORY.md`, with dated task notes and per-session indexes in `TASKS/`
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

Native slash commands are available on Telegram, Slack, and Discord. The existing `!command` syntax remains supported; `/cancel_recovery` corresponds to `!cancel-recovery`. Slash commands must be configured on Slack and Discord before they appear

| Command | Purpose |
| --- | --- |
| `/agent <id>` | Link this conversation to an authorized Agent Session |
| `/status` | Inspect pending work and recovery status |
| `/wake <seconds\|ISO timestamp> <prompt>` | Schedule a wake; absolute timestamps need a timezone |
| `/timers` | List this session's timers |
| `/cancel <timer-id>` | Cancel one of this session's timers |
| `/cancel_recovery` | Cancel scheduled usage-reset recovery |
| `/stop` | Interrupt execution and clear staged input/recovery; future timers remain |
| `/retry` | Retry paused prompt admission, not completed actions |
| `/unlink` | Remove this conversation's link |
| `/help` | List available commands |

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

Set `chat.enabled` to `true` and select platforms in `chat.platforms`. Telegram uses Telegraf long polling and Slack uses Socket Mode automatically; neither needs Redis or a public endpoint. Chat is disabled by default. Discord uses Chat SDK with `REDIS_URL` and a listener at `127.0.0.1:8787`

Expose Discord's webhook route through HTTPS and register it yourself. The plugin does not register or delete webhooks. Each sender must still be in the target Agent Session's allowlist

#### Telegram

- Enable `telegram` in `chat.platforms`
- Telegraf long polling uses only `TELEGRAM_BOT_TOKEN`
- Polling uses outbound requests only, preserves existing webhooks, and stops gracefully with the plugin. Use one polling process per bot
- Startup publishes commands through [`setMyCommands`](https://core.telegram.org/bots/api#setmycommands), replacing the default language-neutral menu. Registration does not alter webhooks or grant session access

Authorize your numeric Telegram user ID before messaging the bot. From the agent project directory:

```sh
LOCATION="location%5Bdirectory%5D=$(node -p 'encodeURIComponent(process.cwd())')"
opencode api post "/api/rpc/octg/list?$LOCATION" --data '{}'
opencode api post "/api/rpc/octg/allowlist?$LOCATION" --data '{"input":{"agentId":"research","users":["telegram:123"]}}'
```

Replace the example session name and user ID with yours. This replaces the session's allowlist; keep all intended users in `users`, then send `/agent <session-name>`. See [Owner management API](#owner-management-api) for session creation and existing-session registration

#### Slack

- Enable `slack` in `chat.platforms`
- Set `SLACK_BOT_TOKEN` (`xoxb-…`) and `SLACK_APP_TOKEN` (`xapp-…`)
- In **Basic Information → App-Level Tokens**, generate an app token with `connections:write`
- Enable **Socket Mode** in Slack app settings. No signing secret, Request URL, tunnel, or Redis is needed
- Enable **Event Subscriptions**, then subscribe to `message.im` and `app_mention`; add `message.channels`, `message.groups`, or `message.mpim` for conversations you use
- Under **App Home**, enable Messages Tab and allow users to send messages and slash commands

In **OAuth & Permissions → Bot Token Scopes**, add:

| Scope | Purpose |
| --- | --- |
| `chat:write` | Send replies |
| `app_mentions:read` | Receive mentions |
| `commands` | Slash commands |
| `users:read` | Resolve sender profiles |
| `im:history`, `im:read` | Direct messages |
| `channels:history`, `channels:read` | Public-channel conversations |

Optional scopes:

- `groups:history`, `groups:read` for private channels
- `mpim:history`, `mpim:read` for group DMs
- `files:read`, `files:write` for incoming attachments and outgoing artifacts

No User Token Scopes are needed. Reinstall the app after changing scopes, then use its Bot User OAuth Token (`xoxb-…`) as `SLACK_BOT_TOKEN`. Event subscriptions and slash commands still require setup in Slack

Authorize your Slack member ID (**your profile → More → Copy member ID**). From the agent project directory:

```sh
LOCATION="location%5Bdirectory%5D=$(node -p 'encodeURIComponent(process.cwd())')"
opencode api post "/api/rpc/octg/list?$LOCATION" --data '{}'
opencode api post "/api/rpc/octg/allowlist?$LOCATION" --data '{"input":{"agentId":"<AGENT_NAME>","users":["slack:U12345678"]}}'
```

Replace the example session name and member ID with yours. This replaces the session's allowlist; keep all intended users in `users`. DM `!agent <session-name>` afterward; no native slash-command registration is needed for `!commands`. Create or register the session first through the [Owner management API](#owner-management-api)

To enable native slash commands:

1. Open your app in [Slack app settings](https://api.slack.com/apps), choose **Slash Commands**, then **Create New Command**
2. Add each command above (`/agent`, `/status`, `/wake`, `/timers`, `/cancel`, `/cancel_recovery`, `/stop`, `/retry`, `/unlink`, `/help`), with a short description and usage hint
3. Save each command. With Socket Mode enabled, a Request URL is not required
4. Ensure the app has the `commands` and `chat:write` bot scopes; reinstall it in the workspace after changing scopes
5. Invite the bot to the channel and run `/agent research` as an allowlisted user

Slack slash commands operate at channel level, not within a particular message thread. A slash-command link covers that channel; mention the bot to chat there. An explicit `!agent` thread link takes precedence for messages in that thread

#### Discord

- Enable `discord` in `chat.platforms`
- Set `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_PUBLIC_KEY`
- Configure `/chat/discord` for interactions
- For ordinary messages, enable `chat.discordGateway` and the appropriate Discord intents
- Register the commands above through the [Discord application command API](https://discord.com/developers/docs/interactions/application-commands), and install the app with `applications.commands`. Use one required string option for commands with arguments, such as `/wake`'s full `<seconds|ISO timestamp> <prompt>` text
- Slash commands use HTTP interactions and do not require Gateway. The plugin handles them but does not register Discord commands

### Memory and timers

Agents use native file edits for memory and task notes:

- `MEMORY.md`: shared, lasting facts
- `TASKS/YYMMDD-task-name.md`: concise task progress, decisions, and next steps, such as `TASKS/261003-task-name.md`
- `TASKS/<agentId>.md`: a short index of that session's task files and next steps

Only bounded shared memory and the corresponding session's index are injected into model context and native compaction. Agents read relevant dated task files as needed; no dedicated memory-writing tool is required

Timers persist in `.octg/timers.json`. The plugin checks them every minute and queues saved prompts into the target session. `octg_wake` schedules a timer from the agent itself

Keep OpenCode and its project plugin active for unattended timers. Overdue timers are admitted when the plugin becomes active again

### Error recovery

API failures produce sanitized chat notifications. Optional `usageResetRecovery` is disabled by default; it uses a bounded future `Retry-After` value from HTTP 429 responses and is capped at three checks

Recovery asks the agent to inspect unfinished task notes rather than replay the failed prompt. It waits for a fresh reset failure between successful admissions. New user activity or `!cancel-recovery` cancels it

### Missing-message diagnostics

Server logs emit JSON stages without message text, tokens, or raw error payloads. Follow `slack.received` → `slack.routing` → `chat.staged` → `native.admitted` → `native.context.observed`. Matching `ref` values correlate transport stages; `chat.staged` supplies the native message ID whose SHA-256 prefix is the native-stage `ref`

- `slack.filtered`: intentionally ignored event, with reason
- `chat.routing.failed`: authorization, attachment, routing, or staging failure
- `native.admission.uncertain`: request failed or timed out; message may already be queued. Automatic admission retries retain the same native ID
- `native.admission.confirmed_by_context`: matching native user message confirms admission after an uncertain response; no replay needed
- `native.admission.paused`: five failed confirmations; inspect `!status` before requesting a retry
- `native.assistant.completed` / `native.session.idle`: session execution signals, correlated by `sessionRef`; they do not establish completion of a particular input

Native admission means queued, not executed. A queued message may not yet appear in active context. Missing context observation alone does not prove loss, especially after compaction. Do not resend message text with a new ID to diagnose an uncertain admission

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

## Owner management API

CLI/RPC interface exists; no dedicated settings UI yet. OpenCode hosts the plugin's `octg` RPC at `POST /api/rpc/octg/<method>`. Use an authenticated OpenCode client; `opencode api` handles the server connection and authentication. These are owner-management calls, not messaging-app commands. Examples use the session name `research`; substitute your own name and user IDs

### Project location and request format

The plugin's registry belongs to a project location. Pass `location[directory]` explicitly so requests reach the plugin in the correct directory. Omitting it can produce `rpc.unavailable` even when the plugin is active elsewhere

Run from your agent project directory:

```sh
LOCATION="location%5Bdirectory%5D=$(node -p 'encodeURIComponent(process.cwd())')"
```

This uses Node to URL-encode the current absolute directory. For a remote server, use the directory path on that server instead. For example, `/absolute/path/to/agents` becomes:

```text
location%5Bdirectory%5D=%2Fabsolute%2Fpath%2Fto%2Fagents
```

Requests carry method arguments under `input`; methods without arguments use `{}`, not `{"input":null}`. The HTTP response wraps a method's return value under `output`. The plugin must be loaded successfully in the selected project before its RPC is available

### Session creation and registration

Create a new native session and authorize its chat users:

```sh
opencode api post "/api/rpc/octg/create?$LOCATION" \
  --data '{"input":{"id":"research","allowedUsers":["slack:U12345678"]}}'
```

To register an existing primary OpenCode session instead, add its native `sessionID`:

```sh
opencode api post "/api/rpc/octg/create?$LOCATION" \
  --data '{"input":{"id":"research","sessionID":"ses_your_existing_session","allowedUsers":["slack:U12345678"]}}'
```

Use one alternative, not both. `id` is the plugin's Agent Session name; names are lowercase and case-sensitive. `sessionID` identifies the native conversation in CLI/web. Registration preserves the existing session's native agent. Duplicate names, already-registered sessions, and child task sessions are rejected

### Allowlist inspection and replacement

List registered sessions, including their `id`, `sessionID`, `allowedUsers`, and conversation bindings:

```sh
opencode api post "/api/rpc/octg/list?$LOCATION" --data '{}'
```

Replace one session's allowlist:

```sh
opencode api post "/api/rpc/octg/allowlist?$LOCATION" \
  --data '{"input":{"agentId":"research","users":["slack:U12345678","telegram:123"]}}'
```

**This replaces the entire allowlist, not appends to it.** Include every user you want to retain. At least one valid platform-prefixed user ID is required: `slack:<member-id>`, `telegram:<numeric-user-id>`, or `discord:<user-id>`. Use user IDs, not bot tokens, usernames, or channel IDs

Changes take effect without a plugin restart. Bindings created by removed users are discarded; remaining bindings still check each sender's authorization. An allowlist authorizes a user but does not link a conversation: the user must send `/agent <session-name>` or `!agent <session-name>` afterward

### Other management calls and access

Session-scoped methods use `agentId`, for example:

```sh
opencode api post "/api/rpc/octg/status?$LOCATION" --data '{"input":{"agentId":"research"}}'
```

The [RPC contract](src/rpc.ts) also defines prompt admission, conversation linking, timers, interruption, retry, recovery cancellation, and native compaction. Typed clients can import it from `@notaunty/opencode-agent/rpc`

Owner RPC calls do not require the owner to appear in a chat allowlist. Protect OpenCode's authenticated API access: anyone able to call these management methods can change chat access and prompt sessions. A chat allowlist is not an API authentication mechanism or a tool-permission sandbox
