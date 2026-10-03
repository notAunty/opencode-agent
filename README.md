# OCTG V2

A clean-room OpenCode V2 plugin for persistent God-thread conversations through OpenCode CLI, web, and Vercel Chat SDK

## Requirements

- Multiple independent primary sessions in one shared project directory
- Shared personality and `MEMORY.md`; isolated short-term notes in `TASKS/<godId>.md`
- Explicit cross-channel linking and a mandatory per-God user allowlist
- Slack, Telegram, and Discord through official Chat SDK adapters
- Native background subagents and automatic compaction, not a second agent runtime
- Durable JSON timers checked every minute to wake a God thread with a saved prompt
- Graceful API-error notifications and optional bounded recovery at verified usage-reset times

See [docs.md](docs.md) for the agreed requirements and architecture

## Provenance

The `v2` seed contains only `README.md`, `AGENTS.md`, and `docs.md`. No V1 code, dependencies, configuration, or runtime data is reused. `main` remains unchanged
