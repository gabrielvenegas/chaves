import { writeFileSync } from "fs";
import { join } from "path";
import { POPULAR_MODELS } from "./modelSetup.js";
import type { AiModelInfo, AiProvider } from "./providers/types.js";
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

export interface ChatCommandContext {
  modelProvider?: AiProvider;
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
    usage: "/model | /model list | /model search <query> | /model set <id|number>",
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
    command: "/failures",
    usage: "/failures [n]",
    description: "List recent debug incidents.",
  },
  {
    command: "/failure",
    usage: "/failure <id>",
    description: "Show a stored debug incident by id.",
  },
  {
    command: "/clear",
    usage: "/clear",
    description: "Clear chat and runtime context, but keep indexed files.",
  },
  {
    command: "/export",
    usage: "/export",
    description: "Export the current conversation to a markdown file.",
  },
  {
    command: "/shortcuts",
    usage: "/shortcuts",
    description: "Show terminal keyboard shortcuts.",
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

function parseRelatedFilesJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
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

function getModelCache(
  store: Store,
  provider: AiProvider,
): AiModelInfo[] | null {
  const raw = store.getConfig(`model_cache:${provider.id}`);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as AiModelInfo[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function setModelCache(
  store: Store,
  provider: AiProvider,
  models: AiModelInfo[],
) {
  store.setConfig(`model_cache:${provider.id}`, JSON.stringify(models));
  store.setConfig(`model_cache_at:${provider.id}`, new Date().toISOString());
}

function getLastModelSearchResults(
  store: Store,
  provider?: AiProvider,
): string[] | null {
  const key = provider
    ? `model_search_results:${provider.id}`
    : "model_search_results";
  const raw = store.getConfig(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === "string")
      : null;
  } catch {
    return null;
  }
}

function setLastModelSearchResults(
  store: Store,
  modelIds: string[],
  provider?: AiProvider,
) {
  const key = provider
    ? `model_search_results:${provider.id}`
    : "model_search_results";
  store.setConfig(key, JSON.stringify(modelIds));
  store.setConfig(`${key}_at`, new Date().toISOString());
}

async function resolveModelSelectionWithSearch(
  store: Store,
  rawValue: string,
  provider?: AiProvider,
): Promise<string | null> {
  const value = rawValue.trim();
  if (!value) return null;

  const numericSelection = Number.parseInt(value, 10);
  if (Number.isFinite(numericSelection)) {
    const searchResults = getLastModelSearchResults(store, provider);
    const selectedSearchModel = searchResults?.[numericSelection - 1];
    if (selectedSearchModel) return selectedSearchModel;

    if (provider) {
      if (searchResults !== null) return null;
      const providerModels = await getSearchableModels(store, provider);
      return providerModels[numericSelection - 1]?.id ?? null;
    }
  }

  if (provider?.id === "codex") {
    const providerModels = await getSearchableModels(store, provider);
    return providerModels.some((model) => model.id === value) ? value : null;
  }

  return resolveModelSelection(value);
}

function formatPrice(rawPrice?: string): string {
  if (!rawPrice) return "-";
  const parsed = Number.parseFloat(rawPrice);
  if (!Number.isFinite(parsed) || parsed <= 0) return rawPrice;
  return `$${parsed.toFixed(parsed < 0.001 ? 6 : 4)}/1K tok`;
}

function rankModel(query: string, model: AiModelInfo): number {
  const q = query.trim().toLowerCase();
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const description = (model.description ?? "").toLowerCase();

  if (id === q) return 1000;
  if (name === q) return 950;
  if (id.startsWith(q)) return 900;
  if (name.startsWith(q)) return 850;
  if (id.includes(q)) return 750;
  if (name.includes(q)) return 700;
  if (description.includes(q)) return 500;
  return 0;
}

export function rankModels(query: string, models: AiModelInfo[]): AiModelInfo[] {
  return models
    .map((model) => ({ model, score: rankModel(query, model) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id))
    .slice(0, 12)
    .map((entry) => entry.model);
}

async function getSearchableModels(
  store: Store,
  provider: AiProvider,
): Promise<AiModelInfo[]> {
  const cachedModels = getModelCache(store, provider);
  const cachedAt = store.getConfig(`model_cache_at:${provider.id}`);
  const maxAgeMs = 24 * 60 * 60 * 1000;

  if (cachedModels !== null && cachedAt) {
    const ageMs = Date.now() - new Date(cachedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeMs) {
      return cachedModels;
    }
  }

  try {
    const models = await provider.listModels();
    setModelCache(store, provider, models);
    return models;
  } catch (error) {
    if (cachedModels !== null) return cachedModels;
    throw error;
  }
}

async function searchModels(
  store: Store,
  query: string,
  provider?: AiProvider,
): Promise<AiModelInfo[]> {
  const models = provider
    ? await getSearchableModels(store, provider)
    : POPULAR_MODELS;
  const ranked = rankModels(query, models);

  setLastModelSearchResults(
    store,
    ranked.map((model) => model.id),
    provider,
  );

  return ranked;
}

function formatModelSearchResults(
  store: Store,
  query: string,
  models: AiModelInfo[],
): string {
  const currentModel = store.getModel();

  if (models.length === 0) {
    return [
      `No models found for "${query}".`,
      "",
      "Try `/model search claude`, `/model search gpt-4o`, or `/model search llama`.",
    ].join("\n");
  }

  return [
    `Model search results for "${query}":`,
    ...models.map((model, index) => {
      const active = model.id === currentModel ? " [current]" : "";
      const context = model.contextLength ? `ctx ${model.contextLength}` : "ctx -";
      const promptPrice = `in ${formatPrice(model.inputPrice)}`;
      const completionPrice = `out ${formatPrice(model.outputPrice)}`;
      const label = model.name !== model.id
        ? `${model.name} - ${model.id}`
        : model.id;
      return `${index + 1}. ${label}${active}\n   ${context} | ${promptPrice} | ${completionPrice}`;
    }),
    "",
    "Use `/model set <number>` to pick one of these results, or `/model set <id>` for an exact model ID.",
  ].join("\n");
}

export function formatModelList(
  currentModel: string,
  models: AiModelInfo[],
): string {
  return [
    "Popular models:",
    ...models.map((model, index) => {
      const active = model.id === currentModel ? " [current]" : "";
      const description = model.description ? ` - ${model.description}` : "";
      const label = model.name !== model.id
        ? `${model.name} - ${model.id}`
        : model.id;
      const context = model.contextLength ? ` | ctx ${model.contextLength}` : "";
      return `${index + 1}. ${label}${active}${description}${context}`;
    }),
  ].join("\n");
}

function formatSetupSummary(store: Store): string {
  return [
    "Current setup:",
    `- provider: ${store.getAiProvider()}`,
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
    "For the full interactive wizard, run `chaves --setup` outside the TUI.",
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

export async function handleSlashCommand(
  text: string,
  store: Store,
  context: ChatCommandContext = {},
) : Promise<ChatCommandResult | null> {
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
          `Use \`/model search <query>\` to search ${context.modelProvider?.displayName ?? "OpenRouter"} models.`,
          "Use `/model set <id|number>` to change the model.",
          ].join("\n"),
        };
      }

      const [subcommand, ...rest] = args;
      if (subcommand?.toLowerCase() === "list") {
        try {
          const models = context.modelProvider
            ? await getSearchableModels(store, context.modelProvider)
            : POPULAR_MODELS;
          setLastModelSearchResults(
            store,
            models.map((model) => model.id),
            context.modelProvider,
          );
          return { output: formatModelList(store.getModel(), models) };
        } catch (error) {
          return {
            output:
              error instanceof Error
                ? `Model list failed: ${error.message}`
                : "Model list failed.",
          };
        }
      }
      if (subcommand?.toLowerCase() === "search") {
        const query = rest.join(" ").trim();
        if (!query) {
          return { output: "Usage: /model search <query>" };
        }

        try {
          const results = await searchModels(store, query, context.modelProvider);
          return { output: formatModelSearchResults(store, query, results) };
        } catch (error) {
          return {
            output:
              error instanceof Error
                ? `Model search failed: ${error.message}`
                : "Model search failed.",
          };
        }
      }

      const rawSelection =
        subcommand?.toLowerCase() === "set" ? rest.join(" ") : args.join(" ");
      const selectedModel = await resolveModelSelectionWithSearch(
        store,
        rawSelection,
        context.modelProvider,
      );
      if (!selectedModel) {
        return {
          output:
            "Usage: /model | /model list | /model search <query> | /model set <id|number>",
        };
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

    case "/failures": {
      const limit = parseLimit(args[0], 10);
      const incidents = store.listDebugIncidents(limit);
      if (incidents.length === 0) return { output: "No debug incidents found." };
      return {
        output: [
          `Last ${incidents.length} debug incidents:`,
          ...incidents.map(
            (incident) =>
              `- #${incident.id} ${incident.timestamp} [${incident.status}] ${incident.headline}`,
          ),
        ].join("\n"),
      };
    }

    case "/failure": {
      const id = Number.parseInt(args[0] ?? "", 10);
      if (!Number.isFinite(id) || id <= 0) {
        return { output: "Usage: /failure <id>" };
      }
      const incident = store.getDebugIncidentById(id);
      if (!incident) return { output: `Debug incident #${id} not found.` };
      const relatedFiles = parseRelatedFilesJson(incident.related_files_json);
      const lines = [
        `Failure #${incident.id}`,
        `timestamp: ${incident.timestamp}`,
        `status: ${incident.status}`,
        `trigger: ${incident.trigger}`,
      ];
      if (incident.exit_code !== null) {
        lines.push(`exit_code: ${incident.exit_code}`);
      }
      if (incident.signal) {
        lines.push(`signal: ${incident.signal}`);
      }
      if (incident.diff_snapshot_id !== null) {
        lines.push(`diff_snapshot_id: ${incident.diff_snapshot_id}`);
      }
      lines.push("", `Headline: ${incident.headline}`, "", "Diagnosis:", incident.summary || "(pending)");
      if (relatedFiles.length > 0) {
        lines.push("", `Related files: ${relatedFiles.join(", ")}`);
      }
      lines.push("", "Log excerpt:", truncate(incident.log_excerpt, 2500));
      return {
        output: lines.join("\n"),
      };
    }

    case "/clear":
      store.clearContext();
      return {
        output:
          "Context cleared. Chat history, summaries, events, diffs, and terminal logs were removed. Indexed files were preserved.",
        effect: "clear_context",
      };

    case "/export": {
      // Get all messages from all channels
      const messages = store.getRecentMessages({ limit: 10000 });
      if (messages.length === 0) return { output: "No conversation to export." };

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `chaves-export-${timestamp}.md`;
      const filepath = join(store.getProjectPath(), filename);

      const content = [
        "# CHAVES Conversation Export",
        `Date: ${new Date().toLocaleString()}`,
        `Model: ${store.getModel()}`,
        "",
        ...messages.map((msg) => {
          const role = msg.role.toUpperCase();
          const channel = msg.channel.toUpperCase();
          const ts = new Date(msg.timestamp).toLocaleString();
          return `### ${role} [${channel}] (${ts})\n\n${msg.content}\n\n---`;
        }),
      ].join("\n");

      try {
        writeFileSync(filepath, content, "utf8");
        return { output: `Conversation exported to: ${filename}` };
      } catch (error) {
        return {
          output: `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case "/shortcuts":
      return {
        output: [
          "Keyboard Shortcuts:",
          "",
          "Navigation:",
          "- Ctrl+L: Toggle between AI Chat and Dev Pane",
          "- PageUp/PageDown: Scroll message history",
          "- Esc: Jump to bottom / Clear unread badge",
          "",
          "Editor:",
          "- Ctrl+K: Clear current chat input",
          "- Ctrl+R: Force re-index codebase",
          "- Alt+Enter: Insert newline without submitting",
          "",
          "UI:",
          "- Ctrl+T: Cycle through themes (warm, slate, forest)",
          "- Ctrl+C: Quit CHAVES",
        ].join("\n"),
      };

    default:
      return {
        output: `Unknown command: ${command}. Use /help for commands.`,
      };
  }
}
