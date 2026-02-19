import { createRequire } from "module";

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
}

export interface ChatUI {
  onSubmit(handler: (text: string) => void): void;
  pushMessage(message: ChatMessage): void;
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
  });

  const header = blessed.box({
    top: 0,
    height: 1,
    left: 0,
    right: 0,
    content: ` 🤖 CHAVES `,
    style: {
      fg: "white",
      bg: "blue",
    },
  });

  const status = blessed.box({
    top: 0,
    height: 1,
    right: 0,
    width: 30,
    content: options.initialStatus ?? "Watching…",
    style: {
      fg: "cyan",
      bg: "blue",
    },
  });

  const transcript = blessed.log({
    top: 1,
    left: 0,
    right: 0,
    bottom: 3,
    border: "line",
    label: " Chat ",
    tags: true,
    keys: true,
    vi: true,
    scrollbar: {
      ch: " ",
      track: {
        bg: "gray",
      },
      style: {
        inverse: true,
      },
    },
    style: {
      border: { fg: "gray" },
    },
  });

  const input = blessed.textbox({
    bottom: 0,
    height: 3,
    left: 0,
    right: 0,
    inputOnFocus: true,
    border: "line",
    label: " You ",
    keys: true,
    style: {
      border: { fg: "gray" },
    },
  });

  screen.append(header);
  screen.append(status);
  screen.append(transcript);
  screen.append(input);

  let submitHandler: ((text: string) => void) | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let statusIndex = 0;

  function renderMessage(msg: ChatMessage): string {
    const time = msg.timestamp
      ? new Date(msg.timestamp).toLocaleTimeString()
      : "";
    const timePrefix = time ? `{gray-fg}${time}{/gray-fg} ` : "";
    const safeContent = escapeTags(msg.content);
    if (msg.role === "user") {
      return `${timePrefix}{white-fg}{bold}YOU:{/bold}{/white-fg} ${safeContent}`;
    }
    if (msg.role === "assistant") {
      return `${timePrefix}{cyan-fg}{bold}CHAVES:{/bold}{/cyan-fg} ${safeContent}`;
    }
    return `${timePrefix}{yellow-fg}{bold}SYSTEM:{/bold}{/yellow-fg} ${safeContent}`;
  }

  function onSubmit(handler: (text: string) => void) {
    submitHandler = handler;
  }

  input.on("submit", (value) => {
    const text = String(value ?? "").trim();
    input.clearValue();
    screen.render();

    if (!text) return;

    logger.debug("UI", "User submitted input");
    submitHandler?.(text);
  });

  input.on("focus", () => {
    // inputOnFocus already handles readInput; keep this no-op to avoid double input
  });

  screen.key(["C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  function pushMessage(message: ChatMessage) {
    transcript.add(renderMessage(message));
    transcript.setScrollPerc(100);
    screen.render();
  }

  function setStatus(text: string) {
    status.setContent(text);
    screen.render();
  }

  function startWatchingIndicator() {
    if (statusTimer) return;
    const interval = options.statusIntervalMs ?? 120;
    statusTimer = setInterval(() => {
      const frame =
        DEFAULT_STATUS_FRAMES[statusIndex % DEFAULT_STATUS_FRAMES.length];
      statusIndex += 1;
      status.setContent(`${frame} Watching…`);
      screen.render();
    }, interval);
  }

  function stopWatchingIndicator() {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = null;
    status.setContent("Watching…");
    screen.render();
  }

  function focusInput() {
    input.focus();
    screen.render();
  }

  function destroy() {
    if (statusTimer) clearInterval(statusTimer);
    screen.destroy();
  }

  screen.render();
  input.focus();

  return {
    onSubmit,
    pushMessage,
    setStatus,
    startWatchingIndicator,
    stopWatchingIndicator,
    focusInput,
    destroy,
  };
}
