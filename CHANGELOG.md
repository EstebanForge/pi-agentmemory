# Changelog

## 1.0.0 (2026-06-10)

Initial release.

- `memory_health` tool: check agentmemory server reachability
- `memory_search` tool: search cross-session memory
- `memory_save` tool: save durable facts to memory
- `/agentmemory-status` command
- `session_start` hook: session ID derivation + health status in footer
- `before_agent_start` hook: auto-recall relevant memories into system prompt
- `agent_end` hook: observe conversation turns back to agentmemory
- Plaintext bearer auth guard via `security.ts`
