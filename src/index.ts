import { createHash, randomUUID } from "crypto";
import { createInterface } from "readline";
import { stripVTControlCharacters } from "util";
import {
  buildFallbackContext,
  buildUserIntentContext,
  handleSlashCommand,
} from "./chatCommands.js";
import { createChavesTools } from "./chaves-tools.js";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "./file-rules.js";
import { Indexer } from "./indexer.js";
import { logger } from "./logger.js";
import { runOnboardingIfNeeded } from "./onboarding.js";
import { runSetup } from "./setup.js";
import {
  Summarizer,
  type MessageFrequencyLevel,
  type Personality,
} from "./summarizer.js";
import {
  Store,
  type ActivityEvent,
  type MessageRole,
  type StoredMessage,
} from "./store.js";
import {
  isInsideManagedTmuxSession,
  killManagedSession,
  maybeBootstrapTmuxSession,
} from "./tmux.js";
import { UI } from "./ui.js";
import { Watcher } from "./watcher.js";

const INDEX_ON_START = parseEnvBool("CHAVES_INDEX_ON_START", true);
const INDEX_MAX_FILE_SIZE = parseEnvInt(
  "CHAVES_INDEX_MAX_FILE_SIZE",
  DEFAULT_MAX_FILE_SIZE_BYTES,
);
const CHAT_CONTEXT_MESSAGES = parseEnvInt("CHAVES_CHAT_CONTEXT_MESSAGES", 20);
const CHAT_SUMMARY_THRESHOLD = parseEnvInt("CHAVES_CHAT_SUMMARY_THRESHOLD", 40);

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isCountableEventType(type: ActivityEvent["event_type"]): boolean {
  return type !== "idle_start" && type !== "idle_end";
}

function isCountableEvent(event: ActivityEvent): boolean {
  return isCountableEventType(event.event_type);
}

function getUniqueFileCount(events: ActivityEvent[]): number {
  return new Set(events.map((event) => event.file_path).filter(Boolean)).size;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapToChatHistory(messages: StoredMessage[]): Array<{
  role: MessageRole;
  content: string;
}> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

async function runTmuxRelayMode(projectPath: string): Promise<void> {
  const store = new Store(projectPath);
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  let lastLine = "";
  let repeatCount = 0;

  const flushRepeatCount = () => {
    if (repeatCount >= 3) {
      store.addTerminalEvent({
        stream: "stdout",
        data: `[repeated ${repeatCount - 2} more times]`,
      });
    }
  };

  const sanitizeLine = (line: string): string => {
    const stripped = stripVTControlCharacters(line)
      .replace(/\r\n/g, "\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    const segments = stripped.split("\r");
    return (segments[segments.length - 1] ?? stripped).trimEnd();
  };

  for await (const rawLine of rl) {
    const line = sanitizeLine(rawLine);
    if (!line) continue;

    if (line === lastLine) {
      repeatCount++;
      if (repeatCount >= 3) continue;
    } else {
      flushRepeatCount();
      lastLine = line;
      repeatCount = 1;
    }

    store.addTerminalEvent({ stream: "stdout", data: line });
  }

  flushRepeatCount();
}

async function main() {
  const args = process.argv.slice(2);
  const relayFlagIndex = args.indexOf("--tmux-relay");

  if (relayFlagIndex !== -1) {
    const relayProjectPath = args[relayFlagIndex + 1];
    if (!relayProjectPath) {
      throw new Error("Missing project path for --tmux-relay");
    }
    await runTmuxRelayMode(relayProjectPath);
    return;
  }

  const setupFlagIndex = ["--setup", "setup"]
    .map((flag) => args.indexOf(flag))
    .find((index) => index !== -1);

  if (setupFlagIndex !== undefined) {
    const maybePath = args[setupFlagIndex + 1];
    const setupPath =
      maybePath && !maybePath.startsWith("-") ? maybePath : process.cwd();
    await runSetup(setupPath);
    return;
  }

  const forceOnboarding = args.includes("--onboarding") || args.includes("onboarding");
  const positionalArgs = args.filter(
    (arg) => arg !== "--onboarding" && arg !== "onboarding" && !arg.startsWith("-"),
  );
  const projectPath = positionalArgs[0] ?? process.cwd();
  const debugMode = process.env.CHAVES_DEBUG === "true";
  const sessionId = randomUUID();

  logger.setDebugMode(debugMode);
  logger.info("CONFIG", debugMode ? "Debug mode enabled" : "Debug mode disabled");
  logger.appStart(projectPath);

  const store = new Store(projectPath);

  const onboardingResult = await runOnboardingIfNeeded({
    projectPath,
    store,
    force: forceOnboarding,
  });
  if (onboardingResult === "aborted") {
    process.exit(0);
  }

  const devCommand = store.getConfig("dev_command")?.trim() ?? "";
  const tmuxBootstrap = maybeBootstrapTmuxSession({
    projectPath,
    devCommand,
  });
  if (tmuxBootstrap.bootstrapped) {
    return;
  }

  const frequencyLevelStr = store.getConfigEnum(
    "message_frequency_level",
    ["1", "2", "3"] as const,
    "2",
  );
  const frequencyLevel = Number.parseInt(
    frequencyLevelStr,
    10,
  ) as MessageFrequencyLevel;
  const personality = store.getConfigEnum(
    "personality",
    ["technical", "collaborative", "creative"] as const,
    "collaborative",
  ) as Personality;

  const inferenceMode = store.getConfigEnum(
    "inference_mode",
    ["managed", "byok"] as const,
    "managed",
  );
  const storedKey = store.getConfig("openrouter_api_key")?.trim() ?? "";
  const apiKey =
    inferenceMode === "byok" && storedKey.length > 0
      ? storedKey
      : process.env.OPENROUTER_API_KEY;

  const baseSummaryThreshold =
    frequencyLevel === 1 ? 25 : frequencyLevel === 3 ? 8 : 15;
  const baseMinUniqueFiles =
    frequencyLevel === 1 ? 3 : frequencyLevel === 3 ? 1 : 2;
  const baseMinCountableEvents =
    frequencyLevel === 1 ? 15 : frequencyLevel === 3 ? 6 : 10;

  const SUMMARY_THRESHOLD = parseEnvInt(
    "CHAVES_SUMMARY_THRESHOLD",
    baseSummaryThreshold,
  );
  const SUMMARY_MIN_UNIQUE_FILES = parseEnvInt(
    "CHAVES_SUMMARY_MIN_FILES",
    baseMinUniqueFiles,
  );
  const SUMMARY_MIN_COUNTABLE_EVENTS = parseEnvInt(
    "CHAVES_SUMMARY_MIN_EVENTS",
    baseMinCountableEvents,
  );

  const summarizer = new Summarizer({
    model: store.getModel(),
    language: store.getLanguage(),
    apiKey,
    frequencyLevel,
    personality,
  });
  const watcher = new Watcher(projectPath);
  const ui = new UI({ showPaneToggleHint: tmuxBootstrap.managed });
  const tools = createChavesTools({ store });
  const indexer = new Indexer(projectPath, store, {
    maxFileSizeBytes: INDEX_MAX_FILE_SIZE,
    batchSize: 25,
  });

  let eventsSinceLastSummary = 0;
  let lastSummarizedEventId = store.getLastSummary()?.event_range_end ?? 0;
  let isSummarizing = false;
  let isSummarizingChat = false;
  let lastEventSummaryPromptHash: string | null = null;
  let lastSummary = store.getLastSummary();
  let lastChatSummary = store.getLastChatSummary();
  let lastChatSummaryEndMessageId = lastChatSummary?.message_range_end ?? 0;

  logger.debug("APP", `Last summarized event ID: ${lastSummarizedEventId}`);

  ui.showWelcome(projectPath);

  if (tmuxBootstrap.managed) {
    ui.showSuccess(`Dev terminal attached on the right (Ctrl+L to switch pane)`);
  } else if (tmuxBootstrap.tmuxMissing) {
    ui.showError(
      "tmux is required for the split dev terminal; continuing in chat-only mode.",
    );
  }

  if (lastSummary) {
    await ui.showSummary(lastSummary.content);
  }

  if (INDEX_ON_START) {
    void (async () => {
      ui.setWatching(false);
      ui.setStatus("Indexing...");
      ui.showInfo("Indexing codebase (one-time)...");
      try {
        const result = await indexer.indexProject();
        ui.showSuccess(
          `Indexed ${result.indexedFiles} files (${result.blockedFiles} blocked, ${result.skippedFiles} skipped)`,
        );
      } catch (error) {
        logger.error("APP", "Codebase indexing failed", error);
        ui.showError("Codebase indexing failed", error as Error);
      } finally {
        ui.setStatus("Watching...");
        ui.setWatching(true);
        ui.focusInput();
      }
    })();
  }

  async function maybeSummarizeChatHistory() {
    if (isSummarizingChat) return;

    const pendingChatMessages = store.getMessagesSince(
      lastChatSummaryEndMessageId,
      "chat",
    );

    if (pendingChatMessages.length < CHAT_SUMMARY_THRESHOLD) return;

    const firstMessageId = pendingChatMessages[0]?.id;
    const lastMessageId = pendingChatMessages.at(-1)?.id;
    if (!firstMessageId || !lastMessageId) return;

    isSummarizingChat = true;

    try {
      const summary = await summarizer.generateChatSummary(
        pendingChatMessages,
        lastChatSummary?.content,
      );

      const savedSummary = store.saveChatSummary(
        summary,
        firstMessageId,
        lastMessageId,
      );

      lastChatSummary = savedSummary;
      lastChatSummaryEndMessageId = savedSummary.message_range_end;
      logger.debug(
        "APP",
        `Saved rolling chat summary up to message #${lastMessageId}`,
      );
    } catch (error) {
      logger.error("APP", "Chat summary generation failed", error);
    } finally {
      isSummarizingChat = false;
    }
  }

  ui.onUserMessage(async (text) => {
    ui.setWatching(false);
    ui.setStatus("Thinking...");

    try {
      const slashOutput = handleSlashCommand(text, store);
      if (slashOutput) {
        if (slashOutput.effect === "clear_context") {
          lastSummarizedEventId = 0;
          eventsSinceLastSummary = 0;
          isSummarizing = false;
          isSummarizingChat = false;
          lastEventSummaryPromptHash = null;
          lastSummary = null;
          lastChatSummary = null;
          lastChatSummaryEndMessageId = 0;
          ui.clearContext();
        }

        await ui.showAssistantMessage(slashOutput.output);
        store.addMessage({
          role: "assistant",
          channel: "info",
          content: slashOutput.output,
          sessionId,
        });
        return;
      }

      const savedUserMessage = store.addMessage({
        role: "user",
        channel: "chat",
        content: text,
        sessionId,
      });

      const recentChatMessages = store
        .getRecentMessages({
          limit: CHAT_CONTEXT_MESSAGES + 1,
          channel: "chat",
        })
        .filter((message) => message.id !== savedUserMessage.id);

      const fallbackContext = buildFallbackContext(store, text);
      const userIntent = buildUserIntentContext(store);
      const reply = await summarizer.generateChat({
        userMessage: text,
        previousSummary: lastSummary?.content,
        previousChatSummary: lastChatSummary?.content,
        userIntent,
        recentMessages: mapToChatHistory(recentChatMessages),
        tools,
        fallbackContext,
      });

      await ui.showAssistantMessage(reply);
      store.addMessage({
        role: "assistant",
        channel: "chat",
        content: reply,
        sessionId,
      });

      await maybeSummarizeChatHistory();
    } catch (error) {
      logger.error("APP", "Chat response failed:", error);
      ui.showError("Chat response failed", error as Error);
      store.addMessage({
        role: "assistant",
        channel: "error",
        content:
          error instanceof Error ? error.message : "Chat response failed",
        sessionId,
      });
    } finally {
      ui.setStatus("Watching...");
      ui.setWatching(true);
      ui.focusInput();
    }
  });

  async function runSummaryIfNeeded() {
    if (isSummarizing || eventsSinceLastSummary < SUMMARY_THRESHOLD) return;

    isSummarizing = true;
    logger.info("APP", "Summary threshold reached, generating summary...");

    try {
      const newEvents = store.getEventsSince(lastSummarizedEventId);
      const countableEvents = newEvents.filter(isCountableEvent);

      logger.debug("APP", `Fetched ${newEvents.length} new events`, {
        countableEvents: countableEvents.length,
      });

      if (countableEvents.length === 0) {
        logger.warn("APP", "No countable events to summarize");
        return;
      }

      const lastEventId = newEvents.at(-1)?.id;
      if (!lastEventId) {
        logger.warn("APP", "No last event ID available for summary");
        return;
      }

      const uniqueFileCount = getUniqueFileCount(countableEvents);
      const isMeaningful =
        countableEvents.length >= SUMMARY_MIN_COUNTABLE_EVENTS ||
        uniqueFileCount >= SUMMARY_MIN_UNIQUE_FILES;

      if (!isMeaningful) {
        logger.info("APP", "Summary skipped (not enough meaningful change)", {
          countableEvents: countableEvents.length,
          uniqueFiles: uniqueFileCount,
        });
        lastSummarizedEventId = lastEventId;
        return;
      }

      const promptHash = hashString(
        summarizer.buildEventSummaryPrompt(
          countableEvents
            .map((event) => `[${event.timestamp}] ${event.event_type}: ${event.file_path}`)
            .join("\n"),
          lastSummary?.content,
        ),
      );

      if (lastEventSummaryPromptHash === promptHash) {
        logger.info("APP", "Summary skipped (prompt unchanged)");
        lastSummarizedEventId = lastEventId;
        return;
      }

      const startTime = Date.now();
      const summary = await summarizer.generateSummary(
        countableEvents,
        lastSummary?.content,
        buildUserIntentContext(store),
      );

      lastEventSummaryPromptHash = promptHash;
      store.saveSummary(summary, lastSummarizedEventId, lastEventId);
      lastSummarizedEventId = lastEventId;
      lastSummary = { content: summary, event_range_end: lastEventId };
      await ui.showSummary(summary);
      store.addMessage({
        role: "assistant",
        channel: "proactive",
        content: summary,
        sessionId,
      });

      logger.info("APP", `Summary done (${Date.now() - startTime}ms)`);
    } catch (error) {
      logger.error("APP", "Summary generation failed:", error);
      if (error instanceof Error) {
        logger.error("APP", `Error details: ${error.message}`);
      }
    } finally {
      isSummarizing = false;
      eventsSinceLastSummary = store
        .getEventsSince(lastSummarizedEventId)
        .filter(isCountableEvent).length;

      logger.debug(
        "APP",
        `Events since last summary: ${eventsSinceLastSummary}/${SUMMARY_THRESHOLD}`,
      );

      if (eventsSinceLastSummary >= SUMMARY_THRESHOLD) {
        await runSummaryIfNeeded();
      }
    }
  }

  watcher.on("event", async (event) => {
    logger.debug("APP", `Event: ${event.type}`, {
      path: event.path,
      details: event.details,
    });

    const saved = store.addEvent({
      event_type: event.type,
      file_path: event.path,
      details: event.details,
    });

    if (
      (event.type === "file_create" || event.type === "file_change") &&
      event.change &&
      (typeof event.change.after === "string" || event.change.blocked)
    ) {
      try {
        store.upsertFile({
          path: event.path,
          content: event.change.after ?? "",
          language: event.change.language ?? "text",
          sizeBytes: Buffer.byteLength(event.change.after ?? "", "utf-8"),
          blocked: Boolean(event.change.blocked),
        });
      } catch (error) {
        logger.debug("APP", "Failed to update indexed file from watcher event", {
          path: event.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (event.type === "file_delete" && event.path) {
      try {
        store.deleteFile(event.path);
      } catch (error) {
        logger.debug("APP", "Failed to delete indexed file from watcher event", {
          path: event.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    ui.logEvent(saved);

    if (isCountableEventType(saved.event_type)) {
      eventsSinceLastSummary++;
    }

    logger.debug(
      "APP",
      `Events since last summary: ${eventsSinceLastSummary}/${SUMMARY_THRESHOLD}`,
    );

    await runSummaryIfNeeded();
  });

  watcher.on("summarize", async (payload) => {
    logger.debug("APP", "Summarize event", {
      changeCount: payload.changes.length,
    });

    if (!payload.prompt) return;

    try {
      store.saveDiffSnapshot(
        payload.prompt,
        JSON.stringify(payload.changes),
        payload.changes.length,
      );

      const text = await summarizer.generateDiff(
        payload.prompt,
        lastSummary?.content,
        buildUserIntentContext(store),
      );

      store.saveSummary(text, lastSummarizedEventId, lastSummarizedEventId);
      lastSummary = { content: text, event_range_end: lastSummarizedEventId };
      await ui.showSummary(text);
      store.addMessage({
        role: "assistant",
        channel: "proactive",
        content: text,
        sessionId,
      });
    } catch (error) {
      logger.error("APP", "Diff summary failed:", error);
      if (error instanceof Error) {
        logger.error("APP", `Error details: ${error.message}`);
      }
    }
  });

  watcher.start();

  logger.info("APP", "CHAVES is now running");

  let cleanedUp = false;

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    watcher.stop();
    ui.destroy();
    if (isInsideManagedTmuxSession()) {
      killManagedSession();
    }
  }

  process.on("exit", () => {
    if (isInsideManagedTmuxSession()) {
      killManagedSession();
    }
  });

  process.on("SIGINT", () => {
    logger.appStop();
    cleanup();
    console.log("\nChaves offline");
    process.exit(0);
  });

  process.on("uncaughtException", (error) => {
    logger.error("APP", "Uncaught exception:", error);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("APP", "Unhandled rejection:", reason);
  });
}

main().catch((error) => {
  logger.error("APP", "Failed to start:", error);
  process.exit(1);
});
