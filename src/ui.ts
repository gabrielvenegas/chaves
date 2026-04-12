import { MarkdownRenderer } from "./markdown/renderer.js";
import { CHAT_COMMANDS, PRIMARY_CHAT_COMMANDS } from "./chatCommands.js";
import { logger } from "./logger.js";
import type { ThemeName } from "./theme.js";
import type { ActivityEvent, TerminalEventRecord } from "./store.js";
import { createChatUI, type ChatMessage, type ChatUI } from "./ui/chat.js";

type UserMessageHandler = (text: string) => Promise<void> | void;

export class UI {
  private lastSummary = "";
  private markdownRenderer: MarkdownRenderer;
  private chat: ChatUI;
  private eventBuffer: ActivityEvent[] = [];
  private readonly maxEventBuffer = 8;
  private userHandler: UserMessageHandler | null = null;

  constructor({
    showPaneToggleHint = false,
    theme = "warm",
  }: {
    showPaneToggleHint?: boolean;
    theme?: ThemeName;
  } = {}) {
    logger.debug("UI", "UI component initialized (native terminal chat)");
    this.markdownRenderer = new MarkdownRenderer();
    this.chat = createChatUI({
      title: "CHAVES",
      initialStatus: "Watching…",
      theme,
      commandHints: showPaneToggleHint
        ? [...PRIMARY_CHAT_COMMANDS, "Ctrl+L: switch pane"]
        : PRIMARY_CHAT_COMMANDS,
      commands: CHAT_COMMANDS,
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

  logTerminalEvent(event: TerminalEventRecord) {
    this.chat.pushLog(event.stream, event.data);
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

  private pushMessage(message: ChatMessage): string {
    return this.chat.pushMessage(message);
  }

  async showAssistantMessage(content: string) {
    try {
      const rendered = await this.markdownRenderer.render(content);
      const formatted = `${rendered}`.trim();
      if (formatted.length > 0) {
        this.pushMessage({
          role: "assistant",
          content: formatted,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      logger.error(
        "UI",
        "Failed to render markdown, falling back to plain text:",
        error,
      );
      this.pushMessage({
        role: "assistant",
        content: `${content}`.trim(),
        timestamp: Date.now(),
      });
    }
  }

  async finalizeAssistantDraft(id: string, content: string) {
    try {
      const rendered = await this.markdownRenderer.render(content);
      const formatted = `${rendered}`.trim();
      this.chat.updateMessage(id, {
        role: "assistant",
        content: formatted.length > 0 ? formatted : content.trim(),
        timestamp: Date.now(),
        transient: false,
      });
    } catch (error) {
      logger.error(
        "UI",
        "Failed to render markdown for assistant draft, falling back to plain text:",
        error,
      );
      this.chat.updateMessage(id, {
        role: "assistant",
        content: `${content}`.trim(),
        timestamp: Date.now(),
        transient: false,
      });
    }
  }

  async showSummary(summary: string) {
    if (summary === this.lastSummary) {
      logger.debug("UI", "Summary unchanged, skipping display");
      return;
    }

    logger.debug("UI", `Showing new summary (${summary.length} chars)`);
    this.lastSummary = summary;

    await this.showAssistantMessage(summary);

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

  setRuntimeInfo(text: string) {
    this.chat.setRuntimeInfo(text);
  }

  setTheme(theme: ThemeName) {
    this.chat.setTheme(theme);
  }

  showProgress(content: string): string {
    return this.pushMessage({
      role: "progress",
      content,
      timestamp: Date.now(),
      transient: true,
    });
  }

  updateMessage(id: string, patch: Partial<ChatMessage>) {
    this.chat.updateMessage(id, patch);
  }

  removeMessage(id: string) {
    this.chat.removeMessage(id);
  }

  startAssistantDraft(initialContent = ""): string {
    return this.pushMessage({
      role: "assistant",
      content: initialContent,
      timestamp: Date.now(),
      transient: true,
    });
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

  clearContext() {
    this.lastSummary = "";
    this.eventBuffer = [];
    this.chat.clearMessages();
  }

  destroy() {
    this.chat.destroy();
  }
}
