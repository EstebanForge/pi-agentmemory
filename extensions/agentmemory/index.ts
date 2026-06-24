import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";
import crypto from "node:crypto";
import { createPlaintextBearerAuthGuard } from "./security.js";
import { ensureServer } from "./server.js";

type TextBlock = { type?: string; text?: string };
type AssistantMessage = { role?: string; content?: unknown };

type SmartSearchResult = {
  title?: string;
  narrative?: string;
  type?: string;
  combinedScore?: number;
  score?: number;
  observation?: {
    title?: string;
    narrative?: string;
    type?: string;
  };
};

type HealthResponse = {
  status?: string;
  service?: string;
  version?: string;
  health?: {
    status?: string;
    notes?: string[];
  };
};

const DEFAULT_URL = process.env.AGENTMEMORY_URL || "http://localhost:3111";
const guardPlaintextBearerAuth = createPlaintextBearerAuthGuard();

const TOOL_GUIDANCE = [
  "agentmemory is available for cross-session memory.",
  "Use memory_search to recall prior decisions, preferences, bugs, and workflows.",
  "Use memory_save when you discover durable facts worth remembering beyond this session.",
].join(" ");

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function getText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [] as string[];
      const block = part as TextBlock;
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      return [] as string[];
    })
    .join("\n")
    .trim();
}

function getLastAssistantText(messages: unknown[]): string {
  for (const msg of [...messages].reverse()) {
    if (!msg || typeof msg !== "object") continue;
    const assistant = msg as AssistantMessage;
    if (assistant.role !== "assistant") continue;
    const text = getText(assistant.content);
    if (text) return text;
  }
  return "";
}

function formatSearchResults(results: SmartSearchResult[]): string {
  if (!results.length) return "No relevant memories found.";
  return results
    .slice(0, 5)
    .map((result, index) => {
      const obs = result.observation ?? result;
      const title = obs.title?.trim() || `Memory ${index + 1}`;
      const narrative = obs.narrative?.trim() || "";
      const type = obs.type?.trim() || "memory";
      const score = result.combinedScore ?? result.score;
      const scoreText =
        typeof score === "number" ? ` [score=${score.toFixed(3)}]` : "";
      return `- ${title} (${type})${scoreText}${narrative ? `: ${narrative}` : ""}`;
    })
    .join("\n");
}

async function callAgentMemory<T>(
  pathname: string,
  options?: {
    method?: "GET" | "POST";
    body?: unknown;
    baseUrl?: string;
  },
): Promise<T | null> {
  const baseUrl = normalizeBaseUrl(
    options?.baseUrl || process.env.AGENTMEMORY_URL || DEFAULT_URL,
  );
  const method = options?.method || "POST";
  const url = `${baseUrl}/agentmemory/${pathname.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = {};
  const secret = process.env.AGENTMEMORY_SECRET;

  guardPlaintextBearerAuth(baseUrl, secret);

  if (options?.body !== undefined) headers["Content-Type"] = "application/json";
  if (secret) headers.Authorization = `Bearer ${secret}`;

  try {
    const response = await fetch(url, {
      method,
      headers,
      body:
        options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export default function agentmemoryExtension(pi: ExtensionAPI) {
  if (process.env.AGENTMEMORY_REQUIRE_HTTPS === "1") {
    guardPlaintextBearerAuth(
      normalizeBaseUrl(process.env.AGENTMEMORY_URL || DEFAULT_URL),
      process.env.AGENTMEMORY_SECRET,
    );
  }

  // Flags surface in `pi config` / the flag editor. registerFlag is static
  // setup at factory top-level (not per session), so user choices persist.
  pi.registerFlag("agentmemory-autostart", {
    description:
      "Start the local agentmemory server automatically when a session starts or a memory tool runs, if it is installed (or via npx when agentmemory-npx-fallback is on). The server is only started when the health check finds it down.",
    type: "boolean",
    default: true,
  });
  pi.registerFlag("agentmemory-npx-fallback", {
    description:
      "If the agentmemory CLI is not on PATH, start it via `npx -y @agentmemory/agentmemory@latest`. Disable to only start a globally-installed server (and otherwise report that it is not installed).",
    type: "boolean",
    default: true,
  });

  let autoStartedNotified = false;
  function ensureOpts() {
    return {
      baseUrl: normalizeBaseUrl(process.env.AGENTMEMORY_URL || DEFAULT_URL),
      secret: process.env.AGENTMEMORY_SECRET,
      autostart: pi.getFlag("agentmemory-autostart") !== false,
      npxFallback: pi.getFlag("agentmemory-npx-fallback") !== false,
    };
  }

  let sessionId = `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
  let currentProject = process.cwd();
  let lastPrompt = "";
  let lastHealthOk = false;
  let pendingSearch: Promise<string> | null = null;

  async function getHealth() {
    return await callAgentMemory<HealthResponse>("health", {
      method: "GET",
    });
  }

  async function refreshStatus(ctx: {
    ui: { setStatus: (key: string, text: string) => void };
  }) {
    const health = await getHealth();
    lastHealthOk =
      !!health &&
      (health.status === "healthy" || health.health?.status === "healthy");
    ctx.ui.setStatus(
      "agentmemory",
      lastHealthOk ? "🧠 agentmemory" : "🧠 agentmemory off",
    );
  }

  // Slash command: /agentmemory-status
  pi.registerCommand("agentmemory-status", {
    description: "Check local agentmemory server health",
    handler: async (_args, ctx) => {
      const health = await getHealth();
      if (!health) {
        ctx.ui.notify(
          "agentmemory is unreachable at http://localhost:3111",
          "warning",
        );
        return;
      }
      ctx.ui.notify(
        `agentmemory ${health.status || health.health?.status || "unknown"}${health.version ? ` v${health.version}` : ""}`,
        "info",
      );
    },
  });

  // Tool: memory_health
  pi.registerTool({
    name: "memory_health",
    label: "Memory Health",
    description:
      "Check whether the local agentmemory server is reachable and healthy",
    parameters: Type.Object({}),
    async execute() {
      const health = await getHealth();
      if (!health) {
        return {
          content: [
            {
              type: "text",
              text: "agentmemory is unreachable at http://localhost:3111",
            },
          ],
          details: { ok: false },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `agentmemory status: ${health.status || health.health?.status || "unknown"}${health.version ? ` (v${health.version})` : ""}`,
          },
        ],
        details: { ...health, ok: true },
      };
    },
    renderResult(result, _renderState, theme) {
      const details = result.details as
        | (HealthResponse & { ok?: boolean })
        | undefined;
      if (!details || details.ok === false)
        return new Text(theme.fg("error", "● agentmemory unreachable"), 0, 0);
      const status = details.status || details.health?.status || "unknown";
      const version = details.version ? ` v${details.version}` : "";
      if (status === "healthy")
        return new Text(
          theme.fg("success", `● agentmemory healthy${version}`),
          0,
          0,
        );
      return new Text(
        theme.fg("warning", `● agentmemory ${status}${version}`),
        0,
        0,
      );
    },
  });

  // Tool: memory_search
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search agentmemory for cross-session project memory, prior decisions, bugs, and user preferences",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for in memory" }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          default: 5,
          description: "Maximum results",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const ensured = await ensureServer(ensureOpts());
      if (!ensured.ok) {
        return {
          content: [{ type: "text", text: ensured.reason }],
          details: { ok: false, query: params.query, results: [] },
        };
      }
      const result = await callAgentMemory<{ results?: SmartSearchResult[] }>(
        "smart-search",
        { body: { query: params.query, limit: params.limit ?? 5 } },
      );
      const results = result?.results || [];
      return {
        content: [{ type: "text", text: formatSearchResults(results) }],
        details: { ok: true, query: params.query, results },
      };
    },
  });

  // Tool: memory_save
  pi.registerTool({
    name: "memory_save",
    label: "Memory Save",
    description:
      "Save a durable fact, convention, workflow, preference, or bug fix into agentmemory",
    parameters: Type.Object({
      content: Type.String({ description: "What should be remembered" }),
      type: Type.Optional(
        Type.String({ description: "Memory type", default: "fact" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const ensured = await ensureServer(ensureOpts());
      if (!ensured.ok) {
        return {
          content: [{ type: "text", text: ensured.reason }],
          details: { ok: false },
        };
      }
      const result = await callAgentMemory<Record<string, unknown>>(
        "remember",
        { body: { content: params.content, type: params.type || "fact" } },
      );
      if (!result) {
        return {
          content: [
            { type: "text", text: "Failed to save memory to agentmemory." },
          ],
          details: { ok: false },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Saved memory (${params.type || "fact"}): ${params.content}`,
          },
        ],
        details: result,
      };
    },
  });

  // Hook: session_start
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    sessionId = sessionFile
      ? path.basename(sessionFile).replace(/\.[^.]+$/, "")
      : `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
    currentProject = process.cwd();
    // Kick the server start off in the background so a cold start (engine
    // download, ~15s) never stalls the session. refreshStatus below does a quick
    // health check; tools and before_agent_start await the shared attempt if
    // they need the server. Snapshot ui for the fire-and-forget callback.
    const { ui } = ctx;
    void ensureServer(ensureOpts())
      .then((ensured) => {
        if (ensured.ok && ensured.started && !autoStartedNotified) {
          autoStartedNotified = true;
          ui.notify("agentmemory server started automatically.", "info");
        }
      })
      .catch(() => {
        /* best-effort; tools retry on demand */
      });
    await refreshStatus(ctx);
  });

  // Hook: before_agent_start (start search, return immediately)
  pi.on("before_agent_start", async (event, ctx) => {
    currentProject = event.systemPromptOptions.cwd || process.cwd();
    lastPrompt = event.prompt?.trim() || "";
    pendingSearch = null;

    if (lastPrompt) {
      pendingSearch = (async () => {
        const result = await callAgentMemory<{ results?: SmartSearchResult[] }>(
          "smart-search",
          { body: { query: lastPrompt, limit: 5 } },
        );
        const results = result?.results || [];
        return results.length
          ? ["Relevant long-term memory from agentmemory:", formatSearchResults(results)].join("\n")
          : "";
      })();
    }

    // Snapshot ui to avoid ctx lifetime issues during fire-and-forget
    const { ui } = ctx;
    void refreshStatus({ ui });
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  // Hook: context (inject search results before first LLM call)
  pi.on("context", async (event) => {
    if (!pendingSearch) return;
    const search = pendingSearch;
    pendingSearch = null;

    const recallBlock = await search;
    if (!recallBlock) return;

    return {
      messages: [
        { role: "user", content: [{ type: "text", text: recallBlock }] } as never,
        ...event.messages,
      ],
    };
  });

  // Hook: agent_end (observe)
  pi.on("agent_end", async (event) => {
    if (!lastHealthOk || !lastPrompt) return;
    const assistantText = getLastAssistantText(event.messages as unknown[]);
    if (!assistantText) return;
    void callAgentMemory("observe", {
      body: {
        hookType: "post_tool_use",
        sessionId,
        project: currentProject,
        cwd: currentProject,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "conversation",
          tool_input: lastPrompt.slice(0, 500),
          tool_output: assistantText.slice(0, 4000),
        },
      },
    });
  });
}
