import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createHash } from "crypto";
import { logger } from "./logger.js";
import { Store, type ActivityEvent } from "./store.js";
import { Summarizer } from "./summarizer.js";
import { UI } from "./ui.js";
import { Watcher } from "./watcher.js";
import { runSetup } from "./setup.js";

const SUMMARY_THRESHOLD = parseEnvInt("CHAVES_SUMMARY_THRESHOLD", 15);
const SUMMARY_MIN_UNIQUE_FILES = parseEnvInt("CHAVES_SUMMARY_MIN_FILES", 2);
const SUMMARY_MIN_COUNTABLE_EVENTS = parseEnvInt(
  "CHAVES_SUMMARY_MIN_EVENTS",
  10,
);

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isCountableEventType(type: ActivityEvent["event_type"]): boolean {
  return type !== "idle_start" && type !== "idle_end";
}

function isCountableEvent(event: ActivityEvent): boolean {
  return isCountableEventType(event.event_type);
}

function buildEventLog(events: ActivityEvent[]): string {
  return events
    .map((e) => `[${e.timestamp}] ${e.event_type}: ${e.file_path}`)
    .join("\n");
}

function getUniqueFileCount(events: ActivityEvent[]): number {
  const unique = new Set(
    events.map((event) => event.file_path).filter(Boolean),
  );
  return unique.size;
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

async function main() {
  const defaultPath = process.argv[2] || process.cwd();

  // Check for setup command
  if (process.argv.includes("--setup") || process.argv.includes("setup")) {
    // Find the path argument after setup
    const setupIndex = process.argv.indexOf("--setup");
    const setupIndex2 = process.argv.indexOf("setup");
    const setupArgIndex = setupIndex !== -1 ? setupIndex : setupIndex2;

    let setupPath = process.cwd();
    // If there's an argument after setup, use it as the path
    if (setupArgIndex !== -1 && process.argv[setupArgIndex + 1]) {
      setupPath = process.argv[setupArgIndex + 1];
    }

    await runSetup(setupPath);
    return;
  }

  const projectPath = defaultPath;

  // Enable debug mode via environment variable (off by default)
  const DEBUG_MODE = process.env.CHAVES_DEBUG === "true";
  logger.setDebugMode(DEBUG_MODE);

  if (DEBUG_MODE) {
    logger.info("CONFIG", "🐛 Debug mode ENABLED");
  } else {
    logger.debug(
      "CONFIG",
      "Debug mode disabled (set CHAVES_DEBUG=true to enable)",
    );
  }

  logger.appStart(projectPath);

  const store = new Store(projectPath);
  const configuredModel = store.getModel();
  const configuredLanguage = store.getLanguage();
  const watcher = new Watcher(projectPath);
  const summarizer = new Summarizer(configuredModel, configuredLanguage);
  const diffClient = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const ui = new UI();

  let eventsSinceLastSummary = 0;
  let lastSummarizedEventId = store.getLastSummary()?.event_range_end ?? 0;
  let isSummarizing = false;
  let lastEventSummaryPromptHash: string | null = null;

  logger.debug("APP", `Last summarized event ID: ${lastSummarizedEventId}`);

  let lastSummary = store.getLastSummary();

  ui.showWelcome(projectPath);

  ui.onUserMessage(async (text) => {
    ui.setWatching(false);
    ui.setStatus("Thinking…");

    const prompt = summarizer.buildChatPrompt(text, lastSummary?.content);
    logger.aiRequest(prompt.length);

    try {
      const { text: reply, response } = await generateText({
        model: diffClient(configuredModel),
        maxTokens: 3000,
        prompt,
      });

      if (reply.trim().length === 0) {
        throw new Error("Empty response returned from AI provider");
      }

      ui.showSummary(reply);
      logger.aiResponse(reply.length);
    } catch (err) {
      logger.error("APP", "❌ Chat response failed:", err);
      ui.showError("Chat response failed", err as Error);
    } finally {
      ui.setStatus("Watching…");
      ui.setWatching(true);
      ui.focusInput();
    }
  });

  // Show last summary if exists
  if (lastSummary) {
    logger.debug("APP", "Found previous summary, displaying...");
    ui.showSummary(lastSummary.content);
  } else {
    logger.debug("APP", "No previous summary found");
  }

  async function runSummaryIfNeeded() {
    if (isSummarizing || eventsSinceLastSummary < SUMMARY_THRESHOLD) {
      return;
    }

    isSummarizing = true;
    logger.info("APP", "📊 Summary threshold reached, generating summary...");

    try {
      const newEvents = store.getEventsSince(lastSummarizedEventId);
      const countableEvents = newEvents.filter(isCountableEvent);

      logger.debug(
        "APP",
        `Fetched ${newEvents.length} new events for summary`,
        {
          countableEvents: countableEvents.length,
        },
      );

      if (countableEvents.length === 0) {
        logger.warn("APP", "No countable events to summarize (unexpected)");
        return;
      }

      const lastEventId = newEvents.at(-1)?.id;
      if (!lastEventId) {
        logger.warn("APP", "No last event ID available for summary");
        return;
      }

      const uniqueFileCount = getUniqueFileCount(countableEvents);
      const eventLog = buildEventLog(countableEvents);
      const prompt = summarizer.buildEventSummaryPrompt(
        eventLog,
        lastSummary?.content,
      );
      const promptHash = hashPrompt(prompt);

      const isMeaningful =
        countableEvents.length >= SUMMARY_MIN_COUNTABLE_EVENTS ||
        uniqueFileCount >= SUMMARY_MIN_UNIQUE_FILES;

      if (!isMeaningful) {
        logger.info(
          "APP",
          "⏭️  Summary skipped (not enough meaningful change)",
          {
            countableEvents: countableEvents.length,
            uniqueFiles: uniqueFileCount,
          },
        );
        lastSummarizedEventId = lastEventId;
        return;
      }

      if (lastEventSummaryPromptHash === promptHash) {
        logger.info("APP", "⏭️  Summary skipped (prompt unchanged)");
        lastSummarizedEventId = lastEventId;
        return;
      }

      const startTime = Date.now();

      const summary = await summarizer.generateSummary(
        countableEvents,
        lastSummary?.content,
      );

      lastEventSummaryPromptHash = promptHash;

      logger.debug("APP", `Last event ID in batch: ${lastEventId}`);

      store.saveSummary(summary, lastSummarizedEventId, lastEventId);

      lastSummarizedEventId = lastEventId;
      lastSummary = { content: summary, event_range_end: lastEventId };
      ui.showSummary(summary);

      const duration = Date.now() - startTime;
      logger.info(
        "APP",
        `✅ Summary generation complete (${duration}ms total)`,
      );
    } catch (err) {
      logger.error("APP", "❌ Summary generation failed:", err);

      if (err instanceof Error) {
        logger.error("APP", `Error details: ${err.message}`);
        logger.debug("APP", `Error stack:`, err.stack);
      }

      // Show error in UI
      console.error("Summary generation failed:", err);
    } finally {
      isSummarizing = false;
      const pendingEvents = store.getEventsSince(lastSummarizedEventId);
      eventsSinceLastSummary = pendingEvents.filter(isCountableEvent).length;

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
    logger.debug("APP", `📨 Received event: ${event.type}`, {
      path: event.path,
      details: event.details,
    });

    const saved = store.addEvent({
      event_type: event.type,
      file_path: event.path,
      details: event.details,
    });

    // Buffer event for chat context (no direct log output)
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
    logger.debug("APP", "📨 Received summarize event", {
      changeCount: payload.changes.length,
    });

    if (!payload.prompt) {
      return;
    }

    try {
      const prompt = summarizer.buildDiffSummaryPrompt(
        payload.prompt,
        lastSummary?.content,
      );

      const changesJson = JSON.stringify(payload.changes);
      store.saveDiffSnapshot(
        payload.prompt,
        changesJson,
        payload.changes.length,
      );

      logger.aiRequest(prompt.length);

      const { text } = await generateText({
        model: diffClient(configuredModel),
        maxTokens: 300,
        prompt,
      });

      if (text.trim().length === 0) {
        throw new Error("Empty summary returned from AI provider");
      }

      store.saveSummary(text, lastSummarizedEventId, lastSummarizedEventId);
      lastSummary = { content: text, event_range_end: lastSummarizedEventId };
      ui.showSummary(text);
    } catch (err) {
      logger.error("APP", "❌ Diff summary generation failed:", err);

      if (err instanceof Error) {
        logger.error("APP", `Error details: ${err.message}`);
        logger.debug("APP", `Error stack:`, err.stack);
      }

      console.error("Diff summary generation failed:", err);
    }
  });

  watcher.start();
  logger.info("APP", "⚡ CHAVES is now running and listening for events");

  process.on("SIGINT", () => {
    logger.appStop();
    watcher.stop();
    ui.destroy();
    console.log("\n👋 Chaves offline");
    process.exit(0);
  });

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    logger.error("APP", "❌ Uncaught exception:", error);
    console.error("Uncaught exception:", error);
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error("APP", "❌ Unhandled rejection at:", promise);
    logger.error("APP", "Reason:", reason);
    console.error("Unhandled rejection:", reason);
  });
}

main().catch((error) => {
  logger.error("APP", "❌ Failed to start application:", error);
  console.error("Failed to start application:", error);
  process.exit(1);
});
