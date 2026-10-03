# V2 requirements and architecture

## Agreed scope

Clean-room rewrite on `v2`, starting with exactly three tracked requirement documents. Implement primarily as an OpenCode V2 plugin. Preserve requirements, not V1 implementation or runtime data

Requirements gathering used `openai/gpt-6.1-sol#medium`. The requirements review identified no documented durable wake timer in the inspected V1 files; the user supplied the V2 timer contract below

## God threads

- A God thread is an independent native primary OpenCode session
- All God threads use the same project directory, personality, and shared long-term `MEMORY.md`
- Short-term memory is `TASKS/<godId>.md`, loaded only for the corresponding God thread
- CLI, OpenCode web, and linked Chat SDK conversations address the same native session
- Multiple conversations may be explicitly linked to a God thread
- Every God thread has a mandatory, separate allowlist of platform-qualified identities, such as `telegram:123`, `slack:U123`, and `discord:123`
- A linked platform conversation is a disclosure boundary: anyone able to read that conversation can read posted replies, even if unable to prompt the agent. Owners must link only conversations with an appropriate audience
- Local authenticated OpenCode clients are trusted owners. Chat senders cannot supply or impersonate this owner identity
- Native foreground/background subagents perform delegated work with native permission enforcement; the primary stays available for new input

## Context management

- Use native automatic compaction and a small recent-context retention budget
- Inject bounded, current shared memory and only the target task notes into God model requests and compaction
- Keep goals, constraints, decisions, pending work, and worker references in short-term notes
- Preserve long-term facts deliberately in `MEMORY.md`, not by appending every transcript
- Do not introduce DCP until V2 compatibility and additional benefit are demonstrated
- Shared files are not security isolation between mutually untrusted agents; use separate projects for that requirement

## Timers

- Plugin-managed, human-readable JSON, checked every minute
- One-shot wakeups accept a delay or absolute UTC timestamp
- Each timer has a stable ID, a God-thread owner, and a saved prompt
- Timers survive process restart and fire when overdue after downtime
- Due prompts enter the native inbox with queued delivery if the agent is busy
- Users can list and cancel timers by ID within their authorized God thread
- Durable admission uses stable native message IDs to avoid duplicate wake prompts on restart
- Timer cancellation cannot retract a prompt already admitted to OpenCode

## Communication

- Official Vercel Chat SDK Slack, Telegram, and Discord adapters in the first implementation
- Persistent self-hosted OpenCode service; no requirement for Vercel hosting
- Explicitly enabled, verified webhook listener; ordinary Discord chat additionally uses Gateway
- Durable Chat SDK state for subscriptions, deduplication, and concurrency queues
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

OpenCode owns models, sessions, transcripts, tools, permissions, subagents, and compaction. The plugin owns God registry, allowlists, chat bindings, bounded memory injection, durable timer admission, notification outbox, and transport lifecycle

Separate domain services from OpenCode and Chat SDK adapters. Use native plugin storage for registry/outbox and an atomic JSON file for timers. Run one plugin instance per project directory; multi-process scheduler leadership is outside this initial scope

No legacy data migration, new provider credential manager, custom model loop, bespoke worker runtime, recurring timers, or host activation is implied

## Acceptance criteria

- Seed commit tracks exactly the three required Markdown files
- All implementation and dependency files are new; no V1 artifacts are carried over
- Two God sessions remain independent while intentionally sharing long-term memory
- Per-God authorization covers linking, messages, attachments, timer creation/listing/cancellation, and notifications
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
