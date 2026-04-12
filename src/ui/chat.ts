import readline from "readline";
import chalk from "chalk";
import type { ChatCommandDefinition } from "../chatCommands.js";
import { logger } from "../logger.js";
import { THEMES, type ThemeDefinition, type ThemeName } from "../theme.js";

export type ChatMessageRole = "user" | "assistant" | "system" | "progress";

export interface ChatMessage {
  id?: string;
  role: ChatMessageRole;
  content: string;
  timestamp?: number;
  transient?: boolean;
}

export interface ChatUIOptions {
  title?: string;
  initialStatus?: string;
  statusIntervalMs?: number;
  commandHints?: readonly string[];
  commands?: readonly ChatCommandDefinition[];
  theme?: ThemeName;
}

export interface ChatUI {
  onSubmit(handler: (text: string) => void): void;
  pushMessage(message: ChatMessage): string;
  updateMessage(id: string, patch: Partial<ChatMessage>): void;
  removeMessage(id: string): void;
  pushLog(stream: "stdout" | "stderr", data: string): void;
  clearMessages(): void;
  setStatus(text: string): void;
  setRuntimeInfo(text: string): void;
  setTheme(themeName: ThemeName): void;
  startWatchingIndicator(): void;
  stopWatchingIndicator(): void;
  focusInput(): void;
  destroy(): void;
}

interface DraftState {
  id: string;
  role: ChatMessageRole;
  startedAt: number;
  content: string;
  isOpen: boolean;
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTimestamp(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : "";
}

function renderLabel(role: ChatMessageRole, theme: ThemeDefinition): string {
  const colorMap: Record<ChatMessageRole, string> = {
    user: theme.user,
    assistant: theme.assistant,
    system: theme.system,
    progress: theme.progress,
  };

  const labelMap: Record<ChatMessageRole, string> = {
    user: "YOU",
    assistant: "CHAVES",
    system: "SYSTEM",
    progress: "STATUS",
  };

  return chalk.hex(colorMap[role]).bold(labelMap[role]);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function createChatUI(options: ChatUIOptions = {}): ChatUI {
  let theme = THEMES[options.theme ?? "warm"];
  let statusText = options.initialStatus ?? "Watching...";
  let runtimeInfo = "";
  let submitHandler: ((text: string) => void) | null = null;
  let destroyed = false;
  let inputFocused = false;

  const drafts = new Map<string, DraftState>();
  const input = process.stdin;
  const output = process.stdout;
  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    historySize: 500,
  });

  function buildPrompt(): string {
    const status = chalk.hex(theme.status)(statusText.replace(/\s+/g, " ").trim());
    return `${status} ${chalk.hex(theme.muted)("›")} `;
  }

  function clearPromptLine() {
    readline.clearLine(output, 0);
    readline.cursorTo(output, 0);
  }

  function restorePrompt(line: string, cursor: number) {
    if (!inputFocused || destroyed) return;
    rl.setPrompt(buildPrompt());
    rl.prompt(true);
    if (line.length > 0) {
      rl.write(line);
      const delta = line.length - cursor;
      if (delta > 0) {
        readline.moveCursor(output, -delta, 0);
      }
    }
  }

  function writeAbovePrompt(text: string) {
    const currentLine = rl.line;
    const cursor = rl.cursor;
    clearPromptLine();
    output.write(ensureTrailingNewline(text));
    restorePrompt(currentLine, cursor);
  }

  function writeInline(text: string) {
    const currentLine = rl.line;
    const cursor = rl.cursor;
    clearPromptLine();
    output.write(text);
    restorePrompt(currentLine, cursor);
  }

  function printMessageBlock(message: ChatMessage) {
    const timestamp = formatTimestamp(message.timestamp ?? Date.now());
    const header = `${renderLabel(message.role, theme)} ${chalk.hex(theme.muted)(timestamp)}`;
    const content = message.content.trimEnd();
    const body = content.length > 0 ? `\n${content}` : "";
    writeAbovePrompt(`${header}${body}\n`);
  }

  function openDraft(message: ChatMessage): DraftState {
    const id = message.id ?? createId();
    const draft: DraftState = {
      id,
      role: message.role,
      startedAt: message.timestamp ?? Date.now(),
      content: message.content,
      isOpen: true,
    };
    drafts.set(id, draft);

    const timestamp = formatTimestamp(draft.startedAt);
    const header = `${renderLabel(draft.role, theme)} ${chalk.hex(theme.muted)(timestamp)}`;
    const initialBody = message.content ? `\n${message.content}` : "\n";
    writeInline(`${header}${initialBody}`);

    return draft;
  }

  function finalizeDraft(id: string) {
    const draft = drafts.get(id);
    if (!draft || !draft.isOpen) return;
    draft.isOpen = false;
    writeInline(draft.content.endsWith("\n") ? "" : "\n");
  }

  rl.on("line", (line) => {
    const text = line.trim();
    inputFocused = false;
    if (!text) {
      focusInput();
      return;
    }

    logger.debug("UI", "User submitted input");
    submitHandler?.(text);
  });

  rl.on("SIGINT", () => {
    process.kill(process.pid, "SIGINT");
  });

  function onSubmit(handler: (text: string) => void) {
    submitHandler = handler;
  }

  function pushMessage(message: ChatMessage): string {
    const id = message.id ?? createId();
    const withId = {
      ...message,
      id,
      timestamp: message.timestamp ?? Date.now(),
    };

    if (withId.transient && withId.role === "assistant") {
      openDraft(withId);
      return id;
    }

    printMessageBlock(withId);
    return id;
  }

  function updateMessage(id: string, patch: Partial<ChatMessage>) {
    const draft = drafts.get(id);
    if (!draft) return;

    const nextContent = patch.content ?? draft.content;
    if (!draft.isOpen) {
      draft.content = nextContent;
      return;
    }

    if (nextContent.startsWith(draft.content)) {
      const delta = nextContent.slice(draft.content.length);
      if (delta) {
        writeInline(delta);
      }
    } else if (nextContent !== draft.content) {
      const replacementNotice =
        `\n${chalk.hex(theme.muted)("[assistant draft refreshed]")}\n${nextContent}`;
      writeInline(replacementNotice);
    }

    draft.content = nextContent;

    if (patch.transient === false) {
      finalizeDraft(id);
    }
  }

  function removeMessage(id: string) {
    const draft = drafts.get(id);
    if (!draft) return;
    finalizeDraft(id);
    drafts.delete(id);
  }

  function pushLog(stream: "stdout" | "stderr", data: string) {
    const prefix = stream === "stderr"
      ? chalk.hex(theme.system)("stderr")
      : chalk.hex(theme.muted)("stdout");
    writeAbovePrompt(`${prefix} ${data}`);
  }

  function clearMessages() {
    drafts.clear();
    console.clear();
  }

  function setStatus(text: string) {
    statusText = text;
    if (statusText.startsWith("Watching")) {
      focusInput();
      return;
    }

    inputFocused = false;
    clearPromptLine();
  }

  function setRuntimeInfo(text: string) {
    runtimeInfo = text;
    void runtimeInfo;
  }

  function setTheme(themeName: ThemeName) {
    theme = THEMES[themeName];
    focusInput();
  }

  function startWatchingIndicator() {
    return;
  }

  function stopWatchingIndicator() {
    return;
  }

  function focusInput() {
    if (destroyed) return;
    inputFocused = true;
    rl.setPrompt(buildPrompt());
    rl.prompt(true);
  }

  function destroy() {
    destroyed = true;
    rl.close();
  }

  if (options.commandHints && options.commandHints.length > 0) {
    writeAbovePrompt(
      `${chalk.hex(theme.muted)("Commands:")} ${options.commandHints.join("  ")}`,
    );
  }

  focusInput();

  return {
    onSubmit,
    pushMessage,
    updateMessage,
    removeMessage,
    pushLog,
    clearMessages,
    setStatus,
    setRuntimeInfo,
    setTheme,
    startWatchingIndicator,
    stopWatchingIndicator,
    focusInput,
    destroy,
  };
}
