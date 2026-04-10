import { createRequire } from "module";
import type { ChatCommandDefinition } from "../chatCommands.js";

const require = createRequire(import.meta.url);
const blessed = require("blessed");
import { logger } from "../logger.js";

export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  timestamp?: number;
}

export interface ChatUIOptions {
  title?: string;
  initialStatus?: string;
  statusIntervalMs?: number;
  commandHints?: readonly string[];
  commands?: readonly ChatCommandDefinition[];
}

export interface ChatUI {
  onSubmit(handler: (text: string) => void): void;
  pushMessage(message: ChatMessage): void;
  pushLog(stream: "stdout" | "stderr", data: string): void;
  clearMessages(): void;
  setStatus(text: string): void;
  startWatchingIndicator(): void;
  stopWatchingIndicator(): void;
  focusInput(): void;
  destroy(): void;
}

const DEFAULT_STATUS_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

const PALETTE = {
  background: "#1f1d1c",
  panel: "#262220",
  border: "#5a4a3d",
  muted: "#8f7d6d",
  text: "#f1ddbf",
  user: "#b39c88",
  assistant: "#f4bc69",
  system: "#c8d35a",
  status: "#ff9b3d",
  track: "#312a26",
};

function escapeTags(text: string): string {
  const helper = (blessed as any).helpers?.escape;
  if (typeof helper === "function") {
    return helper(text);
  }
  return text.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

export function createChatUI(options: ChatUIOptions = {}): ChatUI {
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
    style: {
      bg: PALETTE.panel,
      border: { fg: PALETTE.border },
    },
  });

  const header = blessed.box({
    top: 0,
    height: 1,
    left: 0,
    right: 0,
    content: ` ☕ CHAVES `,
    style: {
      fg: PALETTE.text,
      bg: PALETTE.panel,
    },
  });

  const headerDivider = blessed.line({
    top: 1,
    left: 0,
    right: 0,
    orientation: "horizontal",
    type: "line",
    style: {
      fg: PALETTE.border,
      bg: PALETTE.panel,
    },
  });

  const status = blessed.box({
    top: 0,
    height: 1,
    right: 0,
    width: 28,
    align: "right",
    tags: true,
    content: escapeTags(options.initialStatus ?? "Watching..."),
    style: {
      fg: PALETTE.status,
      bg: PALETTE.panel,
    },
  });

  const transcript = blessed.log({
    top: 2,
    left: 0,
    right: 0,
    bottom: 4,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    alwaysScroll: true,
    scrollable: true,
    padding: {
      top: 1,
      left: 1,
      right: 1,
    },
    scrollbar: {
      ch: " ",
      track: {
        bg: PALETTE.track,
      },
      style: {
        bg: PALETTE.border,
      },
    },
    style: {
      fg: PALETTE.text,
      bg: PALETTE.background,
    },
  });

  const input = blessed.box({
    bottom: 0,
    height: 3,
    left: 0,
    right: 0,
    border: "line",
    label: " You ",
    tags: true,
    keys: true,
    mouse: true,
    style: {
      fg: PALETTE.text,
      bg: PALETTE.panel,
      border: { fg: PALETTE.border },
    },
  });

  const commandMenu = blessed.box({
    bottom: 4,
    height: 0,
    left: 0,
    right: 0,
    hidden: true,
    border: "line",
    label: " Commands ",
    tags: true,
    style: {
      fg: PALETTE.text,
      bg: PALETTE.panel,
      border: { fg: PALETTE.border },
    },
  });

  const commandBar = blessed.box({
    bottom: 3,
    height: 1,
    left: 1,
    right: 1,
    tags: true,
    content:
      options.commandHints && options.commandHints.length > 0
        ? `{gray-fg}Commands:{/gray-fg} ${options.commandHints.join("  ")}`
        : "",
    style: {
      fg: PALETTE.muted,
      bg: PALETTE.panel,
    },
  });

  screen.append(frame);
  frame.append(header);
  frame.append(headerDivider);
  frame.append(status);
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

  // Message buffer — needed to re-render transcript when width changes on resize
  const messageBuffer: ChatMessage[] = [];

  function rerenderTranscript() {
    // Do NOT use add() here — after setContent(""), blessed's _clines.fake is
    // undefined until the next render(), so every add() overwrites line 0.
    // Build the full string and hand it to setContent() in one shot instead.
    const full = messageBuffer.map(renderMessage).join("");
    transcript.setContent(full);
    transcript.setScrollPerc(100);
  }

  function scrollTranscript(lines: number) {
    transcript.scroll(lines);
    screen.render();
  }

  function renderMessage(msg: ChatMessage): string {
    const time = msg.timestamp
      ? new Date(msg.timestamp).toLocaleTimeString()
      : "";
    const timePrefix = time ? `{#8f7d6d-fg}${time}{/} ` : "";
    // Assistant content is pre-rendered blessed tags by MarkdownRenderer.
    // User and system content is plain text and must be escaped.
    const safeContent = msg.role === "assistant"
      ? msg.content
      : escapeTags(msg.content);
    if (msg.role === "user") {
      return `${timePrefix}{#b39c88-fg}{bold}YOU:{/bold}{/} ${safeContent}\n`;
    }
    if (msg.role === "assistant") {
      return `${timePrefix}{#f4bc69-fg}{bold}CHAVES:{/bold}{/} ${safeContent}\n`;
    }
    return `${timePrefix}{#c8d35a-fg}{bold}SYSTEM:{/bold}{/} ${safeContent}\n`;
  }

  function onSubmit(handler: (text: string) => void) {
    submitHandler = handler;
  }

  function getInputInnerWidth(): number {
    const measuredWidth =
      typeof input.width === "number" ? input.width : screen.width;
    return Math.max(1, measuredWidth - 3);
  }

  function renderInput() {
    const width = getInputInnerWidth();

    if (!inputValue) {
      input.setContent(
        `{#8f7d6d-fg}Ask Chaves anything...{/}  {#5a4a3d-fg}"/" for commands{/}`,
      );
      return;
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
      `${before}{inverse}${escapeTags(cursorChar)}{/inverse}${after}`,
    );
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
    transcript.top = 2;
    transcript.left = 0;
    transcript.right = 0;
    transcript.bottom = 4 + commandMenuHeight;
    commandMenu.bottom = 4;

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
            `{#f4bc69-fg}${escapeTags(entry.command)}{/} {#8f7d6d-fg}-{/} ${escapeTags(entry.description)}`,
        )
        .join("\n"),
    );
    commandMenu.show();
    updateLayout();
  }

  function renderInputArea() {
    renderInput();
    renderCommandMenu();
    screen.program.hideCursor();
    screen.render();
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
    submitHandler?.(text);
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
      full?: string;
    },
  ): boolean {
    if (key.ctrl || key.meta || !ch) return false;
    if (key.name === "mouse") return false;
    if (key.sequence && key.sequence !== ch) return false;
    if (/[\x00-\x1f\x7f]/.test(ch)) return false;

    // Rule: only plain printable keyboard text may enter the input buffer.
    // Raw terminal escape sequences, including mouse reporting, must never be
    // inserted here again.
    return Array.from(ch).length >= 1;
  }

  screen.key(["C-c"], () => {
    process.kill(process.pid, "SIGINT");
  });

  screen.key(["pageup"], () => {
    scrollTranscript(
      -Math.max(1, Math.floor((transcript.height as number) / 2)),
    );
  });

  screen.key(["pagedown"], () => {
    scrollTranscript(
      Math.max(1, Math.floor((transcript.height as number) / 2)),
    );
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

  input.on("click", () => {
    focusInput();
  });

  // Keep typing scoped to the input widget. Do not move this back to a global
  // screen-level keypress handler: that makes it too easy for raw terminal and
  // mouse-reporting escape sequences to leak into the input buffer.
  input.on("keypress", (ch: string, key: {
    ctrl?: boolean;
    meta?: boolean;
    name?: string;
    sequence?: string;
    full?: string;
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
      case "pageup":
      case "pagedown":
      case "escape":
        return;
      default:
        break;
    }

    if (!isPrintableKeyboardInput(ch, key)) return;
    insertText(ch);
  });

  function pushMessage(message: ChatMessage) {
    messageBuffer.push(message);
    transcript.add(renderMessage(message));
    transcript.setScrollPerc(100);
    screen.render();
  }

  function pushLog(stream: "stdout" | "stderr", data: string) {
    void stream;
    void data;
  }

  function clearMessages() {
    messageBuffer.length = 0;
    transcript.setContent("");
    transcript.setScrollPerc(0);
    screen.render();
  }

  function setStatus(text: string) {
    status.setContent(escapeTags(text));
    screen.render();
  }

  function startWatchingIndicator() {
    if (statusTimer) return;
    const interval = options.statusIntervalMs ?? 120;
    statusTimer = setInterval(() => {
      const frame =
        DEFAULT_STATUS_FRAMES[statusIndex % DEFAULT_STATUS_FRAMES.length];
      statusIndex += 1;
      status.setContent(`${frame} Watching...`);
      screen.render();
    }, interval);
  }

  function stopWatchingIndicator() {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = null;
    status.setContent("Watching...");
    screen.render();
  }

  function focusInput() {
    input.focus();
    renderInputArea();
  }

  function destroy() {
    if (statusTimer) clearInterval(statusTimer);
    screen.program.hideCursor();
    screen.destroy();
  }

  updateLayout();
  focusInput();

  return {
    onSubmit,
    pushMessage,
    pushLog,
    clearMessages,
    setStatus,
    startWatchingIndicator,
    stopWatchingIndicator,
    focusInput,
    destroy,
  };
}
