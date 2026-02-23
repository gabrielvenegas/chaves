import { MarkdownRenderer } from "./markdown/renderer.js";
import { logger } from "./logger.js";
import type { ActivityEvent } from "./store.js";
import { createChatUI, type ChatMessage, type ChatUI } from "./ui/chat.js";

type UserMessageHandler = (text: string) => Promise<void> | void;

export class UI {
  private lastSummary = "";
  private markdownRenderer: MarkdownRenderer;
  private chat: ChatUI;
  private eventBuffer: ActivityEvent[] = [];
  private readonly maxEventBuffer = 8;
  private userHandler: UserMessageHandler | null = null;

  constructor() {
    logger.debug("UI", "UI component initialized (blessed chat)");
    this.markdownRenderer = new MarkdownRenderer();
    this.chat = createChatUI({
      title: "CHAVES",
      initialStatus: "Watching…",
    });
    this.chat.startWatchingIndicator();
  }

  onUserMessage(handler: UserMessageHandler) {
    this.userHandler = handler;
    this.chat.onSubmit(async (text) => {
      this.pushMessage({
        role: "user",
        content: text,
        timestamp: Date.now(),
      });

      try {
        await this.userHandler?.(text);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        this.showError("Failed to handle user message", error as Error);
        logger.error("UI", "User handler failed", message);
      }
    });
  }

  logEvent(event: ActivityEvent) {
    logger.debug("UI", `Buffering event #${event.id}`, {
      type: event.event_type,
      path: event.file_path,
      timestamp: event.timestamp,
    });

    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxEventBuffer) {
      this.eventBuffer = this.eventBuffer.slice(-this.maxEventBuffer);
    }
  }

  private getIcon(type: string): string {
    const icons: Record<string, string> = {
      file_create: "📄",
      file_change: "✏️",
      file_delete: "🗑️",
      idle_start: "💤",
      idle_end: "⚡",
    };

    return icons[type] ?? "•";
  }

  private formatEventLine(event: ActivityEvent): string {
    const icon = this.getIcon(event.event_type);
    const label = event.file_path || event.event_type;
    return `- ${icon} ${label}`;
  }

  private renderEventsBlock(): string {
    if (this.eventBuffer.length === 0) return "";
    const lines = this.eventBuffer.map((event) => this.formatEventLine(event));
    return `💭 Events\n${lines.join("\n")}\n`;
  }

  private pushMessage(message: ChatMessage) {
    this.chat.pushMessage(message);
  }

  async showSummary(summary: string) {
    if (summary === this.lastSummary) {
      logger.debug("UI", "Summary unchanged, skipping display");
      return;
    }

    logger.debug("UI", `Showing new summary (${summary.length} chars)`);
    this.lastSummary = summary;

    // const eventsBlock = this.renderEventsBlock();

    try {
      const renderedSummary = await this.markdownRenderer.render(summary);
      const content = `${renderedSummary}`.trim();
      if (content.length > 0) {
        this.pushMessage({
          role: "assistant",
          content,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      logger.error(
        "UI",
        "Failed to render markdown, falling back to plain text:",
        error,
      );
      const content = `${summary}`.trim();
      this.pushMessage({
        role: "assistant",
        content,
        timestamp: Date.now(),
      });
    }

    this.eventBuffer = [];
  }

  showWelcome(projectPath: string) {
    logger.debug("UI", "Displaying welcome message");
    this.pushMessage({
      role: "system",
      content: `Watching project: ${projectPath}`,
      timestamp: Date.now(),
    });
  }

  showError(message: string, error?: Error) {
    logger.error("UI", `Displaying error: ${message}`);
    const details = error?.message ? `\n${error.message}` : "";
    this.pushMessage({
      role: "system",
      content: `❌ ${message}${details}`,
      timestamp: Date.now(),
    });
  }

  showInfo(message: string) {
    logger.debug("UI", `Info: ${message}`);
    this.pushMessage({
      role: "system",
      content: `ℹ️ ${message}`,
      timestamp: Date.now(),
    });
  }

  showSuccess(message: string) {
    logger.debug("UI", `Success: ${message}`);
    this.pushMessage({
      role: "system",
      content: `✅ ${message}`,
      timestamp: Date.now(),
    });
  }

  setStatus(text: string) {
    this.chat.setStatus(text);
  }

  setWatching(active: boolean) {
    if (active) {
      this.chat.startWatchingIndicator();
    } else {
      this.chat.stopWatchingIndicator();
    }
  }

  focusInput() {
    this.chat.focusInput();
  }

  destroy() {
    this.chat.destroy();
  }
}
