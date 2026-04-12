import { POPULAR_MODELS } from "./modelSetup.js";
import { type ActivityEvent, Store } from "./store.js";
import { THEME_OPTIONS, isThemeName } from "./theme.js";

export interface ChatCommandDefinition {
  command: string;
  usage: string;
  description: string;
}

export interface ChatCommandResult {
  output: string;
  effect?: "clear_context";
}

interface ChatCommandContext {
  runtimeStats?: {
    cpuPercent: number;
    rssBytes: number;
    heapUsedBytes: number;
  };
}

export const CHAT_COMMANDS: readonly ChatCommandDefinition[] = [
  {
    command: "/help",
    usage: "/help",
    description: "Show the available slash commands.",
  },
  {
    command: "/setup",
    usage: "/setup",
    description: "Show the current model and language setup.",
  },
  {
    command: "/model",
    usage: "/model | /model list | /model set <id|number>",
    description: "Inspect or change the active model.",
  },
  {
    command: "/thinking",
    usage: "/thinking | /thinking <low|medium|high>",
    description: "Inspect or change model reasoning effort.",
  },
  {
    command: "/stats",
    usage: "/stats",
    description: "Show active model plus CPU and memory usage.",
  },
  {
    command: "/theme",
    usage: "/theme | /theme list | /theme set <warm|slate|forest>",
    description: "Inspect or change the terminal theme.",
  },
  {
    command: "/history",
    usage: "/history [n]",
    description: "Show recent chat messages from the local history.",
  },
  {
    command: "/events",
    usage: "/events [n]",
    description: "Show recent filesystem and idle events.",
  },
  {
    command: "/diffs",
    usage: "/diffs [n]",
    description: "List recent diff snapshots.",
  },
  {
    command: "/diff",
    usage: "/diff <id>",
    description: "Show a saved diff snapshot by id.",
  },
  {
    command: "/clear",
    usage: "/clear",
    description: "Clear chat and runtime context, but keep indexed files.",
  },
] as const;

export const PRIMARY_CHAT_COMMANDS = CHAT_COMMANDS.slice(0, 3).map((entry) =>
  entry.command
) as readonly string[];

function parseLimit(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} chars]`;
}

function resolveModelSelection(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) return null;

  const numericSelection = Number.parseInt(value, 10);
  if (Number.isFinite(numericSelection)) {
    const selected = POPULAR_MODELS[numericSelection - 1];
    return selected?.id ?? null;
  }

  return value;
}

function formatModelList(store: Store): string {
  const currentModel = store.getModel();

  return [
    "Popular models:",
    ...POPULAR_MODELS.map((model, index) => {
      const active = model.id === currentModel ? " [current]" : "";
      const description = model.description ? ` - ${model.description}` : "";
      return `${index + 1}. ${model.id}${active}${description}`;
    }),
  ].join("\n");
}

function formatSetupSummary(store: Store): string {
  return [
    "Current setup:",
    `- model: ${store.getModel()}`,
    `- thinking: ${store.getThinkingEffort()}`,
    `- language: ${store.getLanguage()}`,
    `- theme: ${store.getTheme()}`,
    "",
    "Commands:",
    "- /model",
    "- /model list",
    "- /model set <id|number>",
    "- /thinking <low|medium|high>",
    "- /stats",
    "- /theme set <warm|slate|forest>",
    "",
    "For the full interactive wizard, run `bun run setup` outside the TUI.",
  ].join("\n");
}

function formatThemeList(store: Store): string {
  const currentTheme = store.getTheme();

  return [
    "Themes:",
    ...THEME_OPTIONS.map((theme, index) => {
      const active = theme.id === currentTheme ? " [current]" : "";
      return `${index + 1}. ${theme.id}${active} - ${theme.label}`;
    }),
  ].join("\n");
}

function resolveThemeSelection(rawValue: string): string | null {
  const value = rawValue.trim().toLowerCase();
  if (!value) return null;

  const numericSelection = Number.parseInt(value, 10);
  if (Number.isFinite(numericSelection)) {
    const selected = THEME_OPTIONS[numericSelection - 1];
    return selected?.id ?? null;
  }

  return isThemeName(value) ? value : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatStatsOutput(
  store: Store,
  runtimeStats?: ChatCommandContext["runtimeStats"],
): string {
  const lines = [
    "Runtime:",
    `- model: ${store.getModel()}`,
    `- thinking: ${store.getThinkingEffort()}`,
  ];

  if (!runtimeStats) {
    lines.push("- cpu: unavailable");
    lines.push("- rss: unavailable");
    lines.push("- heap used: unavailable");
    return lines.join("\n");
  }

  lines.push(`- cpu: ${runtimeStats.cpuPercent.toFixed(1)}%`);
  lines.push(`- rss: ${formatBytes(runtimeStats.rssBytes)}`);
  lines.push(`- heap used: ${formatBytes(runtimeStats.heapUsedBytes)}`);

  return lines.join("\n");
}

function isCountableEventType(type: ActivityEvent["event_type"]): boolean {
  return type !== "idle_start" && type !== "idle_end";
}

function isLikelyCodeQuery(text: string): boolean {
  return /(where|implement|function|class|method|module|file|path|src\/|\.ts|\.js|\.tsx|\.jsx)/i.test(
    text,
  );
}

export function buildFallbackContext(
  store: Store,
  userMessage: string,
): string {
  const sections: string[] = [];
  const userIntentContext = buildUserIntentContext(store);

  if (userIntentContext) {
    sections.push(userIntentContext);
  }

  const recentEvents = store.getRecentEvents(10).filter((event) =>
    isCountableEventType(event.event_type),
  );
  if (recentEvents.length > 0) {
    sections.push(
      [
        "Recent events:",
        ...recentEvents
          .reverse()
          .map(
            (event) =>
              `- [${event.timestamp}] ${event.event_type} ${event.file_path || ""}`.trim(),
          ),
      ].join("\n"),
    );
  }

  const latestDiff = store.getRecentDiffSnapshots(1).at(0);
  if (latestDiff) {
    sections.push(
      [
        "Latest diff snapshot:",
        `- id: ${latestDiff.id}`,
        `- timestamp: ${latestDiff.timestamp}`,
        `- change_count: ${latestDiff.change_count}`,
        `- prompt:`,
        truncate(latestDiff.prompt, 1200),
      ].join("\n"),
    );
  }

  if (isLikelyCodeQuery(userMessage)) {
    const results = store.searchFiles({ query: userMessage, limit: 3 });
    if (results.length > 0) {
      sections.push(
        [
          "Top code matches:",
          ...results.map(
            (result, index) =>
              `${index + 1}. ${result.path} (${result.language})\n${truncate(result.snippet, 400)}`,
          ),
        ].join("\n"),
      );
    }
  }

  return sections.join("\n\n");
}

export function buildUserIntentContext(store: Store, limit = 6): string {
  const recentUserMessages = store
    .getRecentMessages({ limit: Math.max(limit * 3, 12), channel: "chat" })
    .filter((message) => message.role === "user")
    .slice(-limit);

  if (recentUserMessages.length === 0) return "";

  return [
    "Recent user guidance (highest priority, newest last):",
    ...recentUserMessages.map(
      (message) => `- [${message.timestamp}] ${truncate(message.content, 280)}`,
    ),
  ].join("\n");
}

export function handleSlashCommand(
  text: string,
  store: Store,
  context: ChatCommandContext = {},
): ChatCommandResult | null {
  if (!text.startsWith("/")) return null;

  const [rawCommand, ...args] = text.trim().split(/\s+/);
  const command = rawCommand?.toLowerCase() ?? "";

  switch (command) {
    case "/help":
      return {
        output: [
        "Available commands:",
        ...CHAT_COMMANDS.map((entry) => `- ${entry.usage}`),
        ].join("\n"),
      };

    case "/setup":
      return { output: formatSetupSummary(store) };

    case "/model": {
      if (args.length === 0) {
        return {
          output: [
          `Current model: ${store.getModel()}`,
          "",
          "Use `/model list` to see popular models.",
          "Use `/model set <id|number>` to change the model.",
          ].join("\n"),
        };
      }

      const [subcommand, ...rest] = args;
      if (subcommand?.toLowerCase() === "list") {
        return { output: formatModelList(store) };
      }

      const rawSelection =
        subcommand?.toLowerCase() === "set" ? rest.join(" ") : args.join(" ");
      const selectedModel = resolveModelSelection(rawSelection);
      if (!selectedModel) {
        return { output: "Usage: /model | /model list | /model set <id|number>" };
      }

      store.setModel(selectedModel);
      return {
        output: [
        `Model updated: ${selectedModel}`,
        "",
        `Thinking effort: ${store.getThinkingEffort()}`,
        `Language remains: ${store.getLanguage()}`,
        ].join("\n"),
      };
    }

    case "/thinking": {
      if (args.length === 0) {
        return {
          output: [
            `Current thinking effort: ${store.getThinkingEffort()}`,
            "",
            "Use `/thinking low`, `/thinking medium`, or `/thinking high`.",
          ].join("\n"),
        };
      }

      const value = args[0]?.toLowerCase();
      if (value !== "low" && value !== "medium" && value !== "high") {
        return { output: "Usage: /thinking | /thinking <low|medium|high>" };
      }

      store.setThinkingEffort(value);
      return {
        output: [
          `Thinking effort updated: ${value}`,
          "",
          `Model remains: ${store.getModel()}`,
          `Language remains: ${store.getLanguage()}`,
        ].join("\n"),
      };
    }

    case "/stats":
      return { output: formatStatsOutput(store, context.runtimeStats) };

    case "/theme": {
      if (args.length === 0) {
        return {
          output: [
            `Current theme: ${store.getTheme()}`,
            "",
            "Use `/theme list` to see available themes.",
            "Use `/theme set <warm|slate|forest>` to change it.",
          ].join("\n"),
        };
      }

      const [subcommand, ...rest] = args;
      if (subcommand?.toLowerCase() === "list") {
        return { output: formatThemeList(store) };
      }

      const rawSelection =
        subcommand?.toLowerCase() === "set" ? rest.join(" ") : args.join(" ");
      const selectedTheme = resolveThemeSelection(rawSelection);
      if (!selectedTheme || !isThemeName(selectedTheme)) {
        return {
          output: "Usage: /theme | /theme list | /theme set <warm|slate|forest>",
        };
      }

      store.setTheme(selectedTheme);
      return {
        output: [
          `Theme updated: ${selectedTheme}`,
          "",
          `Model remains: ${store.getModel()}`,
        ].join("\n"),
      };
    }

    case "/history": {
      const limit = parseLimit(args[0], 20);
      const messages = store.getRecentMessages({ limit, channel: "chat" });
      if (messages.length === 0) return { output: "No chat history found." };
      return {
        output: [
        `Last ${messages.length} chat messages:`,
        ...messages.map(
          (message) =>
            `- [${message.timestamp}] ${message.role.toUpperCase()}: ${truncate(message.content, 280)}`,
        ),
        ].join("\n"),
      };
    }

    case "/events": {
      const limit = parseLimit(args[0], 20);
      const events = store.getRecentEvents(limit);
      if (events.length === 0) return { output: "No events found." };
      return {
        output: [
        `Last ${events.length} events:`,
        ...events
          .reverse()
          .map(
            (event) =>
              `- [${event.timestamp}] ${event.event_type}: ${event.file_path || "(no path)"}`,
          ),
        ].join("\n"),
      };
    }

    case "/diffs": {
      const limit = parseLimit(args[0], 10);
      const diffs = store.getRecentDiffSnapshots(limit);
      if (diffs.length === 0) return { output: "No diff snapshots found." };
      return {
        output: [
        `Last ${diffs.length} diff snapshots:`,
        ...diffs.map(
          (diff) =>
            `- #${diff.id} ${diff.timestamp} (changes: ${diff.change_count})`,
        ),
        ].join("\n"),
      };
    }

    case "/diff": {
      const id = Number.parseInt(args[0] ?? "", 10);
      if (!Number.isFinite(id) || id <= 0) {
        return { output: "Usage: /diff <id>" };
      }
      const snapshot = store.getDiffSnapshotById(id);
      if (!snapshot) return { output: `Diff snapshot #${id} not found.` };
      return {
        output: [
        `Diff #${snapshot.id}`,
        `timestamp: ${snapshot.timestamp}`,
        `change_count: ${snapshot.change_count}`,
        "",
        "Prompt:",
        truncate(snapshot.prompt, 2500),
        ].join("\n"),
      };
    }

    case "/clear":
      store.clearContext();
      return {
        output:
          "Context cleared. Chat history, summaries, events, diffs, and terminal logs were removed. Indexed files were preserved.",
        effect: "clear_context",
      };

    default:
      return {
        output: `Unknown command: ${command}. Use /help for commands.`,
      };
  }
}
