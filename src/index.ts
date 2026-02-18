import { createInterface } from "readline/promises";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { logger } from "./logger.js";
import { Store } from "./store.js";
import { Summarizer } from "./summarizer.js";
import { UI } from "./ui.js";
import { Watcher } from "./watcher.js";
import { runSetup } from "./setup.js";

const SUMMARY_THRESHOLD = 10; // Generate summary every N events

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

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = (
    await rl.question(`Enter project path to watch (default: ${defaultPath}): `)
  ).trim();

  rl.close();

  const projectPath = answer || defaultPath;

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

  logger.debug("APP", `Last summarized event ID: ${lastSummarizedEventId}`);

  ui.showWelcome(projectPath);

  // Show last summary if exists
  let lastSummary = store.getLastSummary();
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
      logger.debug("APP", `Fetched ${newEvents.length} new events for summary`);

      if (newEvents.length > 0) {
        const startTime = Date.now();

        const summary = await summarizer.generateSummary(
          newEvents,
          lastSummary?.content,
        );

        const lastEventId = newEvents.at(-1)?.id!;
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
      } else {
        logger.warn("APP", "No new events to summarize (unexpected)");
      }
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
      const pendingCount = store.getEventsSince(lastSummarizedEventId).length;
      eventsSinceLastSummary = pendingCount;

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

    ui.logEvent(saved);
    eventsSinceLastSummary++;

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

      logger.info("APP", "✅ Diff summary generation complete");
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
