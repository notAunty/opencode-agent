# V2 requirements and architecture

## Agreed scope

Clean-room rewrite on `v2`, starting with exactly three tracked requirement documents. Implement primarily as an OpenCode V2 plugin. Preserve requirements, not V1 implementation or runtime data

Requirements gathering used `openai/gpt-6.1-sol#medium`. The requirements review identified no documented durable wake timer in the inspected V1 files; the user supplied the V2 timer contract below

## Agent Sessions

- An Agent Session is an independent native primary OpenCode session. New sessions select the configured `Agent` agent; registration preserves an existing session's selected agent
- The example `Agent` configuration allows all tools without approval prompts and is intended for trusted workspaces
- All Agent Sessions use the same project directory, personality, and shared long-term `MEMORY.md`
- Short-term memory is `TASKS/<agentId>.md`, loaded only for the corresponding Agent Session
- CLI, OpenCode web, and linked Chat SDK conversations address the same native session
- Multiple conversations may be explicitly linked to an Agent Session
- Every Agent Session has a mandatory, separate allowlist of platform-qualified identities, such as `telegram:123`, `slack:U123`, and `discord:123`
- A linked platform conversation is a disclosure boundary: anyone able to read that conversation can read posted replies, even if unable to prompt the agent. Owners must link only conversations with an appropriate audience
- Local authenticated OpenCode clients are trusted owners. Chat senders cannot supply or impersonate this owner identity
- Native foreground/background subagents perform delegated work with native permission enforcement; the primary stays available for new input

## Context management

- Use native automatic compaction and a small recent-context retention budget
- Inject bounded, current shared memory and only the target task notes into main model requests and compaction
- Keep goals, constraints, decisions, pending work, and worker references in short-term notes
- Preserve long-term facts deliberately in `MEMORY.md`, not by appending every transcript
- Do not introduce DCP until V2 compatibility and additional benefit are demonstrated
- Shared files are not security isolation between mutually untrusted agents; use separate projects for that requirement

## Timers

- Plugin-managed, human-readable JSON, checked every minute
- One-shot wakeups accept a delay or absolute UTC timestamp
- Each timer has a stable ID, an Agent Session owner, and a saved prompt
- Timers survive process restart and fire when overdue after downtime
- Due prompts enter the native inbox with queued delivery if the agent is busy
- Users can list and cancel timers by ID within their authorized Agent Session
- Durable admission uses stable native message IDs to avoid duplicate wake prompts on restart
- Timer cancellation cannot retract a prompt already admitted to OpenCode

## Communication

- Support the Chat SDK adapter ecosystem, with Telegram, Slack, and Discord as first-class integrations
- Persistent self-hosted OpenCode service; no requirement for Vercel hosting
- Separate messaging transports share authorization, commands, files, and replies. Telegram uses Telegraf long polling with automatic command registration; Slack uses the official Socket Mode and Web API libraries. Chat SDK adapters remain in the codebase, with Discord using the webhook bridge and optional Gateway
- Durable Chat SDK state for webhook subscriptions, deduplication, and concurrency queues; Telegram and Slack need neither Redis nor a listener
- Persist incoming work before waiting for a model; acknowledge webhooks independently of model execution
- Reject unauthorized users before routing inputs or fetching attachments
- Carry text and image attachments into native prompts; forward explicit assistant image outputs, not arbitrary tool logs
- Persist session bindings and pending notifications across restart
- Do not silently drop overlapping prompts
- Native CLI/web handle permission/question approval initially; chat must report blocked approval rather than grant automatically

## API failures and recovery

- Native retry policy owns immediate retries
- Notify linked chat destinations with concise, sanitized errors, never raw provider payloads or credentials
- Handle HTTP and terminal native session failures, including non-HTTP transports
- Avoid notification storms by deduplicating incidents
- Retry delivery of failed outbound notifications without repeating agent prompts
- Optional usage-reset recovery is bounded and only scheduled from a trustworthy provider reset signal
- Resume by asking the agent to inspect its current task state; do not replay the original task or completed side effects
- Authentication/configuration failures need user action, not infinite retry
- Cancellation, newer user work, and a retry budget suppress stale recovery

## Implementation boundaries

OpenCode owns models, sessions, transcripts, tools, permissions, subagents, and compaction. The plugin owns Agent Session registry, allowlists, chat bindings, bounded memory injection, durable timer admission, notification outbox, and transport lifecycle

Separate domain services from OpenCode and Chat SDK adapters. Use native plugin storage for registry/outbox and an atomic JSON file for timers. Run one plugin instance per project directory; multi-process scheduler leadership is outside this initial scope

No legacy data migration, new provider credential manager, custom model loop, bespoke worker runtime, recurring timers, or host activation is implied

## Acceptance criteria

- Seed commit tracks exactly the three required Markdown files
- All implementation and dependency files are new; no V1 artifacts are carried over
- Two Agent Sessions remain independent while intentionally sharing long-term memory
- Per-session authorization covers linking, messages, attachments, timer creation/listing/cancellation, and notifications
- CLI/web and linked platform conversations continue the same native session
- Restart and duplicate-delivery tests demonstrate stable session and wake-prompt admission
- Delayed/absolute timers, downtime, busy-session queueing, cancellation, and ownership pass tests
- Native compaction remains enabled; memory injection is bounded and task-specific
- API failures produce sanitized notices, delivery retries, and bounded opt-in reset recovery
- Container-only typechecking, unit tests, and plugin/transport fixture tests leave no host services, dependency directories, or bot registrations behind

## Sources

- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/rpc/
- https://opencode.ai/v2/docs/agents/
- https://opencode.ai/v2/docs/compaction/
- https://chat-sdk.dev/docs
- https://chat-sdk.dev/adapters/official/slack
- https://chat-sdk.dev/adapters/official/telegram
- https://chat-sdk.dev/adapters/official/discord

V1 requirement inputs: `main:README.md`, `main:docs/background-agents.md`. Documentation claims were treated as requirements, not runtime guarantees

## Development checkpoint

- Seed commit: `8222380`, exactly the three required documents, on orphan branch `v2`
- Domain interfaces, Agent Session registry, authorization, durable staged inbox/outbox, bounded memory files, and JSON timer services implemented
- OpenCode plugin hooks, tools, RPC, event lifecycle, and official Chat SDK wiring implemented
- Docker verification passes strict typechecking, 29 synthetic tests, compilation, and the real OpenCode V2 SDK fixture, including native storage and timer persistence across restart
- Synthetic webhook fixtures verify Slack signatures, Telegram secrets, and Discord Ed25519 signatures without bot connections
- Browser research completed: prefer native V2 browser tools, with disabled-by-default Playwriter MCP for existing local Chrome; no host activation
- Do not use ignored V1 `node_modules`, `.env`, configuration, or data when resuming

## Operational limits

- Chat SDK native slash handlers, Slack socket commands and Telegraf command handlers share command authorization and timer logic. Telegram menu publication is automatic; Slack and Discord require external command setup. No development run registers real commands
- Slack acknowledges socket envelopes before routing to satisfy the platform deadline. An acknowledged event may be lost if the process crashes before durable staging. The socket library reconnects transport connections; outgoing Web API retries are disabled so application outbox policy owns retries
- Telegraf polling checks for an existing webhook and refuses to replace it. It uses abortable `getUpdates` requests rather than `launch()`, which would delete deployment-owned webhook configuration. Offsets advance after update handling; native admission IDs and durable inbox state limit duplicate prompts on redelivery. This is not an exactly-once transport

- The plugin runs while its OpenCode project location is active; minute timers are not an OS scheduler. Due timers are admitted on restart
- One process owns a project scheduler. Plugin storage is durable but is not a cross-process transactional queue
- Native event subscriptions are live-only. Minute reconciliation reads active session context; replies already compacted during downtime cannot be reconstructed from that endpoint
- External message delivery is at-least-once around crashes. Stable native admission IDs suppress repeated prompts, but platform posts can duplicate if a process dies after delivery and before persistence
- Usage-reset recovery currently trusts a bounded future HTTP `Retry-After` value on a 429 response. No reset time is guessed. Recovery is opt-in, capped at three checks, waits for a fresh reset failure between successful admissions, and does not replay original work
- Native permission requests are reported in chat; native question handling stays in CLI/web. Question-specific chat notifications are not implemented
- Shared browser profiles and files are deliberate shared authority, not isolation between untrusted agents. Native browser availability depends on the chosen OpenCode runtime
- Optional Playwriter is pinned and disabled. It requires an explicitly configured Chrome extension/relay outside development. The `Agent` agent allows all available tools, so enabling the connection grants browser automation unless more restrictive native permissions are configured
- Live Slack/Telegram/Discord delivery and Discord Gateway renewal need deployment smoke tests with dedicated bot credentials. Development never connects real bots
