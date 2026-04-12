import { createRequire } from "module";
import type { ChatCommandDefinition } from "../chatCommands.js";
import { logger } from "../logger.js";
import { THEMES, type ThemeDefinition, type ThemeName } from "../theme.js";

const require = createRequire(import.meta.url);
const blessed = require("blessed");

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

const DEFAULT_STATUS_FRAMES = ["o", "O", "0", "O"];

function escapeTags(text: string): string {
  const helper = (blessed as any).helpers?.escape;
  if (typeof helper === "function") {
    return helper(text);
  }
  return text.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function wrapWithWidth(text: string, width: number): string {
  if (width <= 1) return text;

  const lines = text.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    const visible = line.replace(/\{[^}]+\}/g, "");
    if (visible.length <= width) {
      output.push(line);
      continue;
    }

    let rawLine = line;
    while (rawLine.replace(/\{[^}]+\}/g, "").length > width) {
      let visibleCount = 0;
      let splitIndex = rawLine.length;

      for (let i = 0; i < rawLine.length; i++) {
        if (rawLine[i] === "{") {
          const end = rawLine.indexOf("}", i);
          if (end !== -1) {
            i = end;
            continue;
          }
        }

        visibleCount += 1;
        if (visibleCount >= width) {
          splitIndex = i + 1;
          break;
        }
      }

      output.push(rawLine.slice(0, splitIndex));
      rawLine = rawLine.slice(splitIndex);
    }

    output.push(rawLine);
  }

  return output.join("\n");
}

export function createChatUI(options: ChatUIOptions = {}): ChatUI {
  let theme = THEMES[options.theme ?? "warm"];

  const screen = blessed.screen({
    smartCSR: true,
    title: options.title ?? "CHAVES",
    fullUnicode: true,
    mouse: true,
  });

  const frame = blessed.box({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    border: "line",
  });

  const header = blessed.box({
    top: 0,
    height: 1,
    left: 0,
    width: 14,
    content: " CHAVES ",
  });

  const activity = blessed.box({
    top: 0,
    height: 1,
    left: 15,
    width: 22,
    tags: true,
    content: "",
  });

  const runtime = blessed.box({
    top: 0,
    height: 1,
    left: 38,
    right: 1,
    align: "right",
    tags: true,
    content: "",
  });

  const headerDivider = blessed.line({
    top: 1,
    left: 0,
    right: 0,
    orientation: "horizontal",
    type: "line",
  });

  const transcript = blessed.box({
    top: 2,
    left: 0,
    right: 0,
    bottom: 5,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    padding: {
      top: 1,
      left: 1,
      right: 1,
      bottom: 1,
    },
    scrollbar: {
      ch: " ",
      track: { bg: theme.track },
      style: { bg: theme.border },
    },
  });

  const commandMenu = blessed.box({
    bottom: 5,
    height: 0,
    left: 0,
    right: 0,
    hidden: true,
    border: "line",
    label: " Commands ",
    tags: true,
  });

  const commandBar = blessed.box({
    bottom: 4,
    height: 1,
    left: 1,
    right: 1,
    tags: true,
    content:
      options.commandHints && options.commandHints.length > 0
        ? `{gray-fg}Commands:{/gray-fg} ${options.commandHints.join("  ")}`
        : "",
  });

  const input = blessed.box({
    bottom: 0,
    height: 4,
    left: 0,
    right: 0,
    border: "line",
    label: " Compose ",
    tags: true,
    mouse: true,
  });

  screen.append(frame);
  frame.append(header);
  frame.append(activity);
  frame.append(runtime);
  frame.append(headerDivider);
  frame.append(transcript);
  frame.append(commandMenu);
  frame.append(commandBar);
  frame.append(input);

  let submitHandler: ((text: string) => void) | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let statusIndex = 0;
  let inputValue = "";
  let cursorIndex = 0;
  let commandMenuHeight = 0;
  let statusText = options.initialStatus ?? "Watching";

  const messageBuffer: ChatMessage[] = [];

  function applyTheme() {
    frame.style = {
      bg: theme.panel,
      border: { fg: theme.border },
    };
    header.style = {
      fg: theme.text,
      bg: theme.panel,
      bold: true,
    };
    activity.style = {
      fg: theme.status,
      bg: theme.panel,
      bold: true,
    };
    runtime.style = {
      fg: theme.muted,
      bg: theme.panel,
    };
    // blessed.line sets style.border = style (self-ref) in its constructor.
    // Replacing the whole object would sever that link and crash sattr.
    headerDivider.style.fg = theme.border;
    headerDivider.style.bg = theme.panel;
    transcript.style.fg = theme.text;
    transcript.style.bg = theme.background;
    transcript.style.track = transcript.style.track ?? {};
    transcript.style.scrollbar = transcript.style.scrollbar ?? {};
    transcript.style.track.bg = theme.track;
    transcript.style.scrollbar.bg = theme.border;
    transcript.scrollbar.track.bg = theme.track;
    transcript.scrollbar.style.bg = theme.border;
    commandMenu.style = {
      fg: theme.text,
      bg: theme.panelAlt,
      border: { fg: theme.border },
    };
    commandBar.style = {
      fg: theme.muted,
      bg: theme.panel,
    };
    input.style = {
      fg: theme.text,
      bg: theme.panelAlt,
      border: { fg: theme.border },
    };
  }

  function renderMessage(message: ChatMessage): string {
    const time = message.timestamp
      ? new Date(message.timestamp).toLocaleTimeString()
      : "";
    const body = message.content;
    const safeBody =
      message.role === "assistant" && !message.transient
        ? body
        : escapeTags(body);

    const colors: Record<ChatMessageRole, string> = {
      user: theme.user,
      assistant: theme.assistant,
      system: theme.system,
      progress: theme.progress,
    };

    const labels: Record<ChatMessageRole, string> = {
      user: "YOU",
      assistant: "CHAVES",
      system: "SYSTEM",
      progress: "STATUS",
    };

    const width = Math.max(24, Number(transcript.width ?? screen.width) - 8);
    const wrapped = wrapWithWidth(safeBody, width);
    const lines = wrapped.split("\n");
    const block = [
      `{${colors[message.role]}-fg}{bold}${labels[message.role]}{/bold}{/} {${theme.muted}-fg}${time}{/}`,
      ...lines.map((line) => `  ${line}`),
    ];

    return `${block.join("\n")}\n\n`;
  }

  function rerenderTranscript() {
    transcript.setContent(messageBuffer.map(renderMessage).join("").trimEnd());
    transcript.setScrollPerc(100);
  }

  function getInputInnerWidth(): number {
    const measuredWidth =
      typeof input.width === "number" ? input.width : screen.width;
    return Math.max(1, measuredWidth - 6);
  }

  function placeCaret(relativeCursor: number) {
    void relativeCursor;
    screen.program.hideCursor();
  }

  function renderInput() {
    const width = getInputInnerWidth();

    if (!inputValue) {
      input.setContent(
        `{${theme.cursor}-fg}{inverse} {/inverse}{/} {${theme.muted}-fg}Ask Chaves anything...{/}  {${theme.border}-fg}"/" for commands{/}`,
      );
      return 0;
    }

    const start = Math.max(0, cursorIndex - width + 1);
    const visible = inputValue.slice(start, start + width);
    const relativeCursor = Math.max(0, Math.min(cursorIndex - start, width - 1));
    const cursorChar = visible[relativeCursor] ?? " ";
    const before = escapeTags(visible.slice(0, relativeCursor));
    const after = visible[relativeCursor] == null
      ? ""
      : escapeTags(visible.slice(relativeCursor + 1));

    input.setContent(
      `${before}{${theme.cursor}-fg}{inverse}${escapeTags(cursorChar)}{/inverse}{/}${after}`,
    );
    return relativeCursor;
  }

  function getCommandMatches(): readonly ChatCommandDefinition[] {
    const trimmed = inputValue.trim().toLowerCase();
    if (!trimmed.startsWith("/")) return [];

    const commandPrefix = trimmed.split(/\s+/, 1)[0] ?? "";
    if (commandPrefix === "/") {
      return options.commands ?? [];
    }

    return (options.commands ?? []).filter((entry) =>
      entry.command.startsWith(commandPrefix)
    );
  }

  function updateLayout(forceRerender = false) {
    transcript.bottom = 5 + commandMenuHeight;
    commandMenu.bottom = 5;

    if (forceRerender) {
      rerenderTranscript();
    }
  }

  function renderCommandMenu() {
    const matches = getCommandMatches();
    if (matches.length === 0) {
      commandMenuHeight = 0;
      commandMenu.hide();
      updateLayout();
      return;
    }

    const visibleMatches = matches.slice(0, 6);
    commandMenuHeight = visibleMatches.length + 2;
    commandMenu.height = commandMenuHeight;
    commandMenu.setContent(
      visibleMatches
        .map(
          (entry) =>
            `{${theme.assistant}-fg}${escapeTags(entry.command)}{/} {${theme.muted}-fg}-{/} ${escapeTags(entry.description)}`,
        )
        .join("\n"),
    );
    commandMenu.show();
    updateLayout();
  }

  function renderInputArea() {
    const relativeCursor = renderInput();
    renderCommandMenu();
    screen.render();
    placeCaret(relativeCursor);
  }

  function focusInput() {
    input.focus();
    renderInputArea();
  }

  function scrollTranscript(lines: number) {
    transcript.scroll(lines);
    screen.render();
    placeCaret(Math.min(cursorIndex, getInputInnerWidth() - 1));
  }

  function setStatus(text: string) {
    statusText = text;
    activity.setContent(` {${theme.status}-fg}${escapeTags(statusText)}{/} `);
    screen.render();
    placeCaret(Math.min(cursorIndex, getInputInnerWidth() - 1));
  }

  function startWatchingIndicator() {
    if (statusTimer) return;
    const interval = options.statusIntervalMs ?? 220;
    statusTimer = setInterval(() => {
      const frameChar =
        DEFAULT_STATUS_FRAMES[statusIndex % DEFAULT_STATUS_FRAMES.length];
      statusIndex += 1;
      activity.setContent(
        ` {${theme.status}-fg}${frameChar}{/} {${theme.status}-fg}${escapeTags(statusText)}{/}`,
      );
      screen.render();
      placeCaret(Math.min(cursorIndex, getInputInnerWidth() - 1));
    }, interval);
  }

  function stopWatchingIndicator() {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = null;
    setStatus(statusText);
  }

  function setRuntimeInfo(text: string) {
    runtime.setContent(escapeTags(text));
    screen.render();
    placeCaret(Math.min(cursorIndex, getInputInnerWidth() - 1));
  }

  function pushMessage(message: ChatMessage): string {
    const id = message.id ?? createId();
    messageBuffer.push({
      ...message,
      id,
      timestamp: message.timestamp ?? Date.now(),
    });
    rerenderTranscript();
    screen.render();
    placeCaret(Math.min(cursorIndex, getInputInnerWidth() - 1));
    return id;
  }

  function updateMessage(id: string, patch: Partial<ChatMessage>) {
    const index = messageBuffer.findIndex((message) => message.id === id);
    if (index === -1) return;
    const current = messageBuffer[index];
    if (!current) return;
    messageBuffer[index] = {
      ...current,
      ...patch,
      role: patch.role ?? current.role,
      content: patch.content ?? current.content,
    };
    rerenderTranscript();
    screen.render();
    placeCaret(Math.min(cursorIndex, getInputInnerWidth() - 1));
  }

  function removeMessage(id: string) {
    const index = messageBuffer.findIndex((message) => message.id === id);
    if (index === -1) return;
    messageBuffer.splice(index, 1);
    rerenderTranscript();
    screen.render();
    placeCaret(Math.min(cursorIndex, getInputInnerWidth() - 1));
  }

  function clearMessages() {
    messageBuffer.length = 0;
    transcript.setContent("");
    transcript.setScrollPerc(0);
    screen.render();
    placeCaret(Math.min(cursorIndex, getInputInnerWidth() - 1));
  }

  function pushLog(stream: "stdout" | "stderr", data: string) {
    void stream;
    void data;
  }

  function clearInput() {
    inputValue = "";
    cursorIndex = 0;
    renderInputArea();
  }

  function submitInput() {
    const text = inputValue.trim();
    clearInput();
    if (!text) return;
    logger.debug("UI", "User submitted input");
    setImmediate(() => {
      submitHandler?.(text);
    });
  }

  function insertText(text: string) {
    inputValue =
      inputValue.slice(0, cursorIndex) + text + inputValue.slice(cursorIndex);
    cursorIndex += text.length;
    renderInputArea();
  }

  function deleteBackward() {
    if (cursorIndex === 0) return;
    inputValue =
      inputValue.slice(0, cursorIndex - 1) + inputValue.slice(cursorIndex);
    cursorIndex -= 1;
    renderInputArea();
  }

  function deleteForward() {
    if (cursorIndex >= inputValue.length) return;
    inputValue =
      inputValue.slice(0, cursorIndex) + inputValue.slice(cursorIndex + 1);
    renderInputArea();
  }

  function isPrintableKeyboardInput(
    ch: string,
    key: {
      ctrl?: boolean;
      meta?: boolean;
      name?: string;
      sequence?: string;
    },
  ): boolean {
    if (key.ctrl || key.meta || !ch) return false;
    if (key.name === "mouse") return false;
    if (key.sequence && key.sequence !== ch) return false;
    if (/[\x00-\x1f\x7f]/.test(ch)) return false;
    return Array.from(ch).length >= 1;
  }

  function setTheme(themeName: ThemeName) {
    theme = THEMES[themeName];
    applyTheme();
    renderCommandMenu();
    rerenderTranscript();
    renderInputArea();
    setStatus(statusText);
  }

  function onSubmit(handler: (text: string) => void) {
    submitHandler = handler;
  }

  screen.key(["C-c"], () => {
    process.kill(process.pid, "SIGINT");
  });

  screen.key(["pageup"], () => {
    scrollTranscript(-Math.max(1, Math.floor(Number(transcript.height ?? 10) / 2)));
  });

  screen.key(["pagedown"], () => {
    scrollTranscript(Math.max(1, Math.floor(Number(transcript.height ?? 10) / 2)));
  });

  screen.key(["up"], () => {
    scrollTranscript(-1);
  });

  screen.key(["down"], () => {
    scrollTranscript(1);
  });

  transcript.on("wheelup", () => scrollTranscript(-3));
  transcript.on("wheeldown", () => scrollTranscript(3));

  screen.on("resize", () => {
    updateLayout(true);
    renderInputArea();
  });

  [frame, header, activity, runtime, transcript, commandBar, input].forEach((node) => {
    node.on("click", () => {
      focusInput();
    });
  });

  screen.on("keypress", (ch: string, key: {
    ctrl?: boolean;
    meta?: boolean;
    name?: string;
    sequence?: string;
  }) => {
    if (key.ctrl && (key.name === "c" || key.name === "l")) return;

    switch (key.name) {
      case "enter":
        submitInput();
        return;
      case "backspace":
        deleteBackward();
        return;
      case "delete":
        deleteForward();
        return;
      case "left":
        cursorIndex = Math.max(0, cursorIndex - 1);
        renderInputArea();
        return;
      case "right":
        cursorIndex = Math.min(inputValue.length, cursorIndex + 1);
        renderInputArea();
        return;
      case "home":
        cursorIndex = 0;
        renderInputArea();
        return;
      case "end":
        cursorIndex = inputValue.length;
        renderInputArea();
        return;
      case "tab":
      case "escape":
        return;
      default:
        break;
    }

    if (!isPrintableKeyboardInput(ch, key)) return;
    insertText(ch);
  });

  applyTheme();
  updateLayout();
  setStatus(statusText);
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
    destroy() {
      if (statusTimer) clearInterval(statusTimer);
      screen.program.hideCursor();
      screen.destroy();
    },
  };
}
