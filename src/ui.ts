import chalk from "chalk";
import { readFileSync } from "fs";
import { MarkdownRenderer } from "./markdown/renderer.js";
import { logger } from "./logger.js";
import type { ActivityEvent } from "./store.js";

export class UI {
  private lastSummary = "";
  private markdownRenderer: MarkdownRenderer;

  constructor() {
    logger.debug("UI", "UI component initialized");
    this.markdownRenderer = new MarkdownRenderer();
  }

  logEvent(event: ActivityEvent) {
    const time = new Date(event.timestamp).toLocaleTimeString();
    const icon = this.getIcon(event.event_type);

    logger.debug("UI", `Displaying event #${event.id}`, {
      type: event.event_type,
      path: event.file_path,
      timestamp: event.timestamp,
    });

    console.log(
      chalk.dim(`[${time}]`),
      icon,
      chalk.cyan(event.file_path || event.event_type),
    );

    logger.debug("UI", `Event #${event.id} displayed to console`);
  }

  private getIcon(type: string): string {
    const icons: Record<string, string> = {
      file_create: "📄",
      file_change: "✏️ ",
      file_delete: "🗑️ ",
      idle_start: "💤",
      idle_end: "⚡",
    };

    const icon = icons[type] || "•";
    logger.debug("UI", `Icon for ${type}: ${icon}`);

    return icon;
  }

  async showSummary(summary: string) {
    if (summary === this.lastSummary) {
      logger.debug("UI", "Summary unchanged, skipping display");
      return;
    }

    logger.debug("UI", `Showing new summary (${summary.length} chars)`);
    logger.debug("UI", "Summary content:", summary);

    this.lastSummary = summary;

    try {
      const renderedSummary = await this.markdownRenderer.render(summary);
      if (renderedSummary.trim().length > 0) {
        console.log(`\n\n${renderedSummary}`);
      } else {
        logger.debug("UI", "Glow rendered directly to stdout; skipping echo");
      }
    } catch (error) {
      logger.error(
        "UI",
        "Failed to render markdown, falling back to plain text:",
        error,
      );
      console.log("\n" + chalk.bgBlue.white(" 🤖 CHAVES ") + "\n");
      console.log(chalk.white(summary));
    }

    console.log(chalk.dim("─".repeat(50)) + "\n");

    logger.debug("UI", "Summary displayed to console");
  }

  showWelcome(projectPath: string) {
    logger.debug("UI", "Displaying welcome screen");
    logger.debug("UI", `Project path: ${projectPath}`);

    console.clear();
    try {
      const ascii = readFileSync(
        new URL("../chaves-ascii", import.meta.url),
        "utf8",
      );
      console.log(chalk.blue(ascii));
    } catch (error) {
      logger.warn(
        "UI",
        "Failed to load chaves-ascii, falling back to title only",
        error,
      );
    }

    console.log(chalk.dim(`  Project: ${projectPath}`));
    console.log(chalk.dim("─".repeat(50)) + "\n");

    logger.debug("UI", "Welcome screen displayed");
  }

  showError(message: string, error?: Error) {
    logger.error("UI", `Displaying error: ${message}`);

    console.error(chalk.red("\n❌ Error:"), message);

    if (error) {
      logger.debug("UI", `Error details: ${error.message}`);
      console.error(chalk.dim(error.message));
    }

    console.log();
  }

  showInfo(message: string) {
    logger.debug("UI", `Info: ${message}`);
    console.log(chalk.blue("ℹ️ "), message);
  }

  showSuccess(message: string) {
    logger.debug("UI", `Success: ${message}`);
    console.log(chalk.green("✅"), message);
  }
}
