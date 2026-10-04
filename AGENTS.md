# Development boundaries

- Work exclusively in this repository directory
- Do not change host OpenCode configuration, install host dependencies, or start host services
- Test builds and runtime behavior in disposable Docker containers with synthetic credentials and fixtures
- Never activate real bot connections, register/delete real webhooks, or run Terraform apply during development
- Preserve ignored local V1 data and secrets; never use them as V2 fixtures
- Keep implementation independent of V1 source; requirement documents are the only retained input
- Prefer OpenCode V2 native sessions, subagents, permissions, compaction, plugin tools, hooks, RPC, and storage
- Use official V2 documentation, not V1 server/plugin interfaces
- Comments explain enduring reasons, not implementation narration
- Agent Sessions share the project directory and intentional long-term memory, but task notes and allowlists are isolated
- External users must be authorized for the target Agent Session before prompts, files, commands, or replies are routed
- Do not promise exactly-once external side effects or silently retry completed agent actions
