# @estebanforge/pi-agentmemory

Pi-native [agent-memory.dev](https://agent-memory.dev) tools. Bypasses MCP entirely — direct REST to the agentmemory server with automatic recall injection.

## Install

```
pi install npm:@estebanforge/pi-agentmemory
```

Requires the agentmemory server running locally. See [agent-memory.dev](https://agent-memory.dev) for docs or [github.com/rohitg00/agentmemory](https://github.com/rohitg00/agentmemory) for the source.

## Tools

| Tool | Description |
| --- | --- |
| `memory_health` | Check whether the agentmemory server is reachable and healthy |
| `memory_search` | Search memory for prior decisions, preferences, bugs, and workflows |
| `memory_save` | Save a durable fact, convention, or bug fix into memory |

## Hooks

| Hook | Behavior |
| --- | --- |
| `session_start` | Derives session ID, checks server health, sets footer status |
| `before_agent_start` | Auto-recalls relevant memories via smart-search, injects into system prompt |
| `agent_end` | Observes conversation turn back to agentmemory for future recall |

## Command

| Command | Description |
| --- | --- |
| `/agentmemory-status` | Check server health from the command palette |

## Configuration

Set environment variables (preferred):

```bash
export AGENTMEMORY_URL=http://localhost:3111    # default
export AGENTMEMORY_SECRET=your-secret            # optional
export AGENTMEMORY_REQUIRE_HTTPS=1               # enforce HTTPS for non-loopback
```

## How it works

On every prompt, the extension searches agentmemory for relevant context and injects it into the system prompt. After the agent responds, the conversation turn is observed back to agentmemory so future sessions can recall it.

No MCP server required. The extension talks directly to the agentmemory REST API.
