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

function getUniqueFileCount(events: ActivityEvent[]): number {
  return new Set(events.map((e) => e.file_path).filter(Boolean)).size;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const args = process.argv.slice(2);
  const setupFlagIndex = ["--setup", "setup"]
    .map((f) => args.indexOf(f))
    .find((i) => i !== -1);

  if (setupFlagIndex !== undefined) {
    const setupPath = args[setupFlagIndex + 1] ?? process.cwd();
    await runSetup(setupPath);
    return;
  }

  const projectPath = args[0] ?? process.cwd();
  const DEBUG_MODE = process.env.CHAVES_DEBUG === "true";

  logger.setDebugMode(DEBUG_MODE);
  logger.info(
    "CONFIG",
    DEBUG_MODE ? "🐛 Debug mode ENABLED" : "Debug mode disabled",
  );
  logger.appStart(projectPath);

  const store = new Store(projectPath);
  const summarizer = new Summarizer(store.getModel(), store.getLanguage());
  const watcher = new Watcher(projectPath);
  const ui = new UI();

  let eventsSinceLastSummary = 0;
  let lastSummarizedEventId = store.getLastSummary()?.event_range_end ?? 0;
  let isSummarizing = false;
  let lastEventSummaryPromptHash: string | null = null;
  let lastSummary = store.getLastSummary();

  logger.debug("APP", `Last summarized event ID: ${lastSummarizedEventId}`);

  ui.showWelcome(projectPath);

  if (lastSummary) {
    ui.showSummary(lastSummary.content);
  }

  ui.onUserMessage(async (text) => {
    ui.setWatching(false);
    ui.setStatus("Thinking…");

    try {
      const reply = await summarizer.generateChat(text, lastSummary?.content);
      ui.showSummary(reply);
    } catch (err) {
      logger.error("APP", "❌ Chat response failed:", err);
      ui.showError("Chat response failed", err as Error);
    } finally {
      ui.setStatus("Watching…");
      ui.setWatching(true);
      ui.focusInput();
    }
  });

  async function runSummaryIfNeeded() {
    if (isSummarizing || eventsSinceLastSummary < SUMMARY_THRESHOLD) return;

    isSummarizing = true;
    logger.info("APP", "📊 Summary threshold reached, generating summary...");

    try {
      const newEvents = store.getEventsSince(lastSummarizedEventId);
      const countableEvents = newEvents.filter(isCountableEvent);

      logger.debug("APP", `Fetched ${newEvents.length} new events`, {
        countableEvents: countableEvents.length,
      });

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

      const promptHash = hashString(
        summarizer.buildEventSummaryPrompt(
          countableEvents
            .map((e) => `[${e.timestamp}] ${e.event_type}: ${e.file_path}`)
            .join("\n"),
          lastSummary?.content,
        ),
      );

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
      store.saveSummary(summary, lastSummarizedEventId, lastEventId);
      lastSummarizedEventId = lastEventId;
      lastSummary = { content: summary, event_range_end: lastEventId };
      ui.showSummary(summary);

      logger.info("APP", `✅ Summary done (${Date.now() - startTime}ms)`);
    } catch (err) {
      logger.error("APP", "❌ Summary generation failed:", err);
      if (err instanceof Error) {
        logger.error("APP", `Error details: ${err.message}`);
        logger.debug("APP", "Error stack:", err.stack);
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
    logger.debug("APP", `📨 Event: ${event.type}`, {
      path: event.path,
      details: event.details,
    });

    const saved = store.addEvent({
      event_type: event.type,
      file_path: event.path,
      details: event.details,
    });

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
    logger.debug("APP", "📨 Summarize event", {
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
      );

      store.saveSummary(text, lastSummarizedEventId, lastSummarizedEventId);
      lastSummary = { content: text, event_range_end: lastSummarizedEventId };
      ui.showSummary(text);
    } catch (err) {
      logger.error("APP", "❌ Diff summary failed:", err);
      if (err instanceof Error) {
        logger.error("APP", `Error details: ${err.message}`);
        logger.debug("APP", "Error stack:", err.stack);
      }
    }
  });

  watcher.start();
  logger.info("APP", "⚡ CHAVES is now running");

  process.on("SIGINT", () => {
    logger.appStop();
    watcher.stop();
    ui.destroy();
    console.log("\n👋 Chaves offline");
    process.exit(0);
  });

  process.on("uncaughtException", (error) => {
    logger.error("APP", "❌ Uncaught exception:", error);
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error("APP", "❌ Unhandled rejection at:", reason);
  });
}

main().catch((error) => {
  logger.error("APP", "❌ Failed to start:", error);
  process.exit(1);
});
