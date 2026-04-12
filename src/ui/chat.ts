import readline from "readline";
import chalk from "chalk";
import { Writable } from "stream";
import { stripVTControlCharacters } from "util";
import type { ChatCommandDefinition } from "../chatCommands.js";
import { logger } from "../logger.js";
import { THEMES, type ThemeDefinition, type ThemeName } from "../theme.js";

// ─── Public types (interface unchanged) ───────────────────────────────────

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

// ─── Internal types ────────────────────────────────────────────────────────

interface MessageRecord {
  id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  transient: boolean;
  isLog: boolean;
  logStream?: "stdout" | "stderr";
}

// ─── ANSI helpers (pure string functions) ─────────────────────────────────

const ESC = "\x1b";
const moveTo = (row: number, col: number): string => `${ESC}[${row};${col}H`;
const HIDE_CURSOR  = `${ESC}[?25l`;
const SHOW_CURSOR  = `${ESC}[?25h`;
const ENTER_ALT    = `${ESC}[?1049h`;
const EXIT_ALT     = `${ESC}[?1049l`;
const CLEAR_SCREEN = `${ESC}[2J`;

// ─── Text utilities (ANSI-aware) ───────────────────────────────────────────

function visibleLength(text: string): number {
  return stripVTControlCharacters(text).length;
}

function truncateVisible(text: string, width: number): string {
  if (width <= 0 || visibleLength(text) <= width) return text;
  const target = Math.max(1, width - 1);
  let visible = 0;
  let index = 0;
  while (index < text.length && visible < target) {
    if (text[index] === "\u001b") {
      const match = /^\u001b\[[0-9;]*m/.exec(text.slice(index));
      if (match) { index += match[0].length; continue; }
    }
    visible++;
    index++;
  }
  return `${text.slice(0, index)}…`;
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 0 || visibleLength(text) <= width) return [text];
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let current = "";
  for (const part of words) {
    if (!part) continue;
    if (visibleLength(current + part) <= width) { current += part; continue; }
    if (current.trim()) { lines.push(current.trimEnd()); current = part.trimStart(); continue; }
    let remainder = part;
    while (visibleLength(remainder) > width) {
      let vis = 0; let idx = 0;
      while (idx < remainder.length && vis < width) {
        if (remainder[idx] === "\u001b") {
          const m = /^\u001b\[[0-9;]*m/.exec(remainder.slice(idx));
          if (m) { idx += m[0].length; continue; }
        }
        vis++; idx++;
      }
      lines.push(remainder.slice(0, idx));
      remainder = remainder.slice(idx);
    }
    current = remainder;
  }
  if (current) lines.push(current.trimEnd());
  return lines.length ? lines : [text];
}

function wrapBlock(text: string, width: number, indent = "  "): string {
  return text
    .split("\n")
    .flatMap((line) =>
      wrapLine(line, Math.max(12, width - indent.length)).map((w) => `${indent}${w}`)
    )
    .join("\n");
}

// ─── Box drawing ───────────────────────────────────────────────────────────

function padToWidth(text: string, width: number): string {
  const vl = visibleLength(text);
  if (vl === width) return text;
  if (vl > width) return truncateVisible(text, width);
  return text + " ".repeat(width - vl);
}

function topBorder(title: string, cols: number, theme: ThemeDefinition): string {
  const inner = cols - 2;
  const lbl = `─ ${title} `;
  const fill = "─".repeat(Math.max(0, inner - lbl.length - 1));
  return chalk.hex(theme.border)(`┌${lbl}${fill}─┐`);
}

function midBorder(label: string | null, cols: number, theme: ThemeDefinition): string {
  const inner = cols - 2;
  if (label) {
    const lbl = `─ ${label} `;
    const fill = "─".repeat(Math.max(0, inner - lbl.length - 1));
    return chalk.hex(theme.border)(`├${lbl}${fill}─┤`);
  }
  return chalk.hex(theme.border)(`├${"─".repeat(inner)}┤`);
}

function bottomBorder(cols: number, theme: ThemeDefinition): string {
  return chalk.hex(theme.border)(`└${"─".repeat(cols - 2)}┘`);
}

function contentRow(text: string, cols: number, theme: ThemeDefinition): string {
  return chalk.hex(theme.border)("│") + padToWidth(text, cols - 2) + chalk.hex(theme.border)("│");
}

// ─── Misc ──────────────────────────────────────────────────────────────────

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

const ROLE_LABEL: Record<ChatMessageRole, string> = {
  user: "YOU", assistant: "CHAVES", system: "SYSTEM", progress: "STATUS",
};

function roleColor(role: ChatMessageRole, theme: ThemeDefinition): string {
  return { user: theme.user, assistant: theme.assistant, system: theme.system, progress: theme.progress }[role];
}

// ─── Factory ───────────────────────────────────────────────────────────────

export function createChatUI(options: ChatUIOptions = {}): ChatUI {
  let theme = THEMES[options.theme ?? "warm"];
  let statusText = options.initialStatus ?? "Watching…";
  let runtimeInfo = "";
  let submitHandler: ((text: string) => void) | null = null;
  let destroyed = false;

  let cols = Math.max(40, process.stdout.columns ?? 80);
  let rows = Math.max(10, process.stdout.rows ?? 24);

  const messages: MessageRecord[] = [];
  let cachedLines: string[] | null = null;
  let cachedCols = 0;

  let scrollOffset = 0;
  let unreadCount = 0;
  let inputLine = "";
  let inputCursor = 0;
  let multiLineBuffer: string[] = [];
  let matchingCommands: readonly ChatCommandDefinition[] = [];
  let renderPending = false;
  let lastRenderTime = 0;

  // ── Layout constants ─────────────────────────────────────────────────────
  // Header: 3 rows (top border + subtitle + separator)
  // Footer: 5 rows base (input-sep + input + status-sep + status + bottom border)
  // Viewport: rows 4 .. (rows - FOOTER)

  const HEADER = 3;

  function getFooterRows() {
    // Base is 5 rows. Each extra line in multiLineBuffer adds 1 row.
    return 5 + multiLineBuffer.length;
  }

  function vpStart() { return HEADER + 1; }          // row 4 (1-indexed)
  function vpEnd()   { return rows - getFooterRows(); }
  function inputLineRow() { return vpEnd() + 2 + multiLineBuffer.length; }

  function pickerRowCount() {
    return matchingCommands.length > 0 ? 1 + matchingCommands.length : 0;
  }

  function effectiveVH() {
    return Math.max(1, vpEnd() - vpStart() + 1 - pickerRowCount());
  }

  function iw() { return cols - 2; }

  // ── Message rendering ─────────────────────────────────────────────────────

  function renderMessageToLines(msg: MessageRecord): string[] {
    const width = iw();

    if (msg.isLog) {
      const tag = msg.logStream === "stderr"
        ? chalk.hex(theme.system)("err")
        : chalk.hex(theme.muted)("out");
      return wrapLine(`  ${tag}  ${chalk.hex(theme.muted)(msg.content.trimEnd())}`, width);
    }

    const lines: string[] = [""];  // leading blank acts as message separator

    const label = chalk.hex(roleColor(msg.role, theme)).bold(ROLE_LABEL[msg.role]);
    const ts    = chalk.hex(theme.muted)(formatTimestamp(msg.timestamp));
    lines.push(`  ${label}  ${ts}`);

    if (msg.content.trim() === "" && msg.transient) {
      lines.push(chalk.hex(theme.muted)("  …"));
    } else {
      const suffix  = msg.transient ? ` ${chalk.hex(theme.muted)("▋")}` : "";
      const raw     = msg.content.trimEnd() + suffix;
      const wrapped = wrapBlock(raw, Math.max(12, width - 2), "  ");
      lines.push(...wrapped.split("\n"));
    }

    return lines;
  }

  function getLines(): string[] {
    if (cachedLines === null || cachedCols !== cols) {
      const result: string[] = [];
      for (const msg of messages) result.push(...renderMessageToLines(msg));
      cachedLines = result;
      cachedCols  = cols;
    }
    return cachedLines;
  }

  function invalidate() { cachedLines = null; }

  // ── Render ───────────────────────────────────────────────────────────────

  function filterCommands(input: string): readonly ChatCommandDefinition[] {
    if (!options.commands?.length) return [];
    const q = input.toLowerCase().trim();
    if (q === "/") return options.commands;
    return options.commands.filter((c) => c.command.startsWith(q));
  }

  function subtitleText(): string {
    const hints = (options.commandHints ?? [])
      .map((h) => chalk.hex(theme.muted)(h))
      .join(`  ${chalk.hex(theme.muted)("·")}  `);
    const sep = hints ? `  ${chalk.hex(theme.muted)("|")}  ${hints}` : "";
    return truncateVisible(`  ${chalk.hex(theme.muted)("AI Coding Companion")}${sep}`, iw());
  }

  function statusText_(): string {
    const dot    = chalk.hex(theme.muted)("·");
    const status = chalk.hex(theme.status).bold(statusText.replace(/\s+/g, " ").trim());
    const rt     = runtimeInfo ? `  ${dot}  ${chalk.hex(theme.muted)(runtimeInfo)}` : "";
    return truncateVisible(
      `  ${chalk.hex(theme.assistant).bold("chaves")}  ${dot}  ${status}${rt}`,
      iw(),
    );
  }

  function inputText(): string {
    // prefix: "  › " = 4 visible chars
    const prefix    = `  ${chalk.hex(theme.assistant).bold("›")} `;
    const available = Math.max(1, iw() - 4);

    if (inputLine.length === 0 && multiLineBuffer.length === 0) {
      return prefix + truncateVisible(chalk.hex(theme.muted)("Write a message…"), available);
    }

    const viewStart = Math.max(0, inputCursor - available);
    return prefix + inputLine.slice(viewStart, viewStart + available);
  }

  function cursorCol(): number {
    // │ (1) + "  › " (4) = col 6 for first char; cursor at inputCursor - viewStart
    const available = Math.max(1, iw() - 4);
    const viewStart = Math.max(0, inputCursor - available);
    return 6 + (inputCursor - viewStart);
  }

  function renderAll() {
    renderPending = false;
    if (destroyed) return;
    lastRenderTime = Date.now();

    if (rows < 10 || cols < 30) {
      process.stdout.write(HIDE_CURSOR + moveTo(1, 1) + CLEAR_SCREEN + moveTo(1, 1) + "Terminal too small." + SHOW_CURSOR);
      return;
    }

    const evh      = effectiveVH();
    const pRows    = pickerRowCount();
    const allLines = getLines();
    const total    = allLines.length;

    // Clamp and compute viewport slice
    let sliceStart = 0;
    if (total > evh) {
      const maxOff = total - evh;
      scrollOffset = Math.max(0, Math.min(scrollOffset, maxOff));
      sliceStart   = maxOff - scrollOffset;
    } else {
      scrollOffset = 0;
    }

    if (scrollOffset === 0) {
      unreadCount = 0;
    }

    const buf: string[] = [HIDE_CURSOR, moveTo(1, 1)];

    // Row 1: top border
    buf.push(topBorder(options.title ?? "CHAVES", cols, theme), "\r\n");
    // Row 2: subtitle
    buf.push(contentRow(subtitleText(), cols, theme), "\r\n");
    // Row 3: separator
    buf.push(midBorder(null, cols, theme), "\r\n");

    // Rows 4..(vpEnd-pRows): viewport content
    const vpContentEnd = vpEnd() - pRows;
    for (let row = vpStart(); row <= vpContentEnd; row++) {
      const lineIdx = sliceStart + (row - vpStart());
      const line    = lineIdx < total ? (allLines[lineIdx] ?? "") : "";

      // Overlay scroll badge if on the last row of the viewport
      if (row === vpContentEnd && unreadCount > 0 && scrollOffset > 0) {
        const badgeText = ` ↑ ${unreadCount} new message${unreadCount > 1 ? "s" : ""} — Esc to jump ↓ `;
        const badge = chalk.bgBlue.white.bold(badgeText);
        const blen = visibleLength(badgeText);
        const padding = Math.max(0, Math.floor((iw() - blen) / 2));
        const left = padToWidth(line.slice(0, padding), padding);
        const right = padToWidth(line.slice(padding + blen), iw() - padding - blen);
        buf.push(chalk.hex(theme.border)("│") + left + badge + right + chalk.hex(theme.border)("│"), "\r\n");
      } else {
        buf.push(contentRow(line, cols, theme), "\r\n");
      }
    }

    // Command picker
    if (pRows > 0) {
      buf.push(midBorder("COMMANDS", cols, theme), "\r\n");
      for (const cmd of matchingCommands) {
        const name = chalk.hex(theme.assistant).bold(cmd.command.padEnd(14));
        const desc = chalk.hex(theme.muted)(cmd.description);
        buf.push(contentRow(truncateVisible(`  ${name}  ${desc}`, iw()), cols, theme), "\r\n");
      }
    }

    // Footer
    buf.push(midBorder("INPUT", cols, theme), "\r\n");

    // Render multi-line buffer lines
    for (const line of multiLineBuffer) {
      buf.push(contentRow(`    ${chalk.hex(theme.muted)(line)}`, cols, theme), "\r\n");
    }

    buf.push(contentRow(inputText(), cols, theme), "\r\n");
    buf.push(midBorder(null, cols, theme), "\r\n");
    buf.push(contentRow(statusText_(), cols, theme), "\r\n");
    buf.push(bottomBorder(cols, theme));  // no \r\n — last row

    // Position cursor in input area
    buf.push(moveTo(inputLineRow(), inputLine.length === 0 && multiLineBuffer.length === 0 ? 6 : cursorCol()));
    buf.push(SHOW_CURSOR);

    process.stdout.write(buf.join(""));
  }

  function scheduleRender() {
    if (renderPending || destroyed) return;
    renderPending = true;

    const now = Date.now();
    const elapsed = now - lastRenderTime;
    const minDelay = 33; // ~30fps

    if (elapsed >= minDelay) {
      setImmediate(renderAll);
    } else {
      setTimeout(renderAll, minDelay - elapsed);
    }
  }

  // ── Silent readline ───────────────────────────────────────────────────────

  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  Object.defineProperty(sink, "columns", { get: () => cols });
  Object.defineProperty(sink, "rows",    { get: () => rows });

  const rl = readline.createInterface({
    input: process.stdin,
    output: sink,
    terminal: true,
    historySize: 500,
  });

  readline.emitKeypressEvents(process.stdin, rl);

  process.stdin.prependListener("keypress", (ch, key) => {
    if (!key || destroyed) return;

    // Scrolling when input is empty or Shift is held
    if (key.name === "up" || key.name === "down") {
      if (!inputLine && multiLineBuffer.length === 0) {
        if (key.name === "up") {
          scrollOffset += 1;
        } else {
          scrollOffset = Math.max(0, scrollOffset - 1);
        }
        scheduleRender();
        // Stop event from reaching readline
        (rl as any)._input.pause();
        setImmediate(() => (rl as any)._input.resume());
        return;
      }
    }

    // Shift+Enter or Alt+Enter for multi-line continuation
    const isEnter = key.name === "return" || key.name === "enter";
    const isShiftEnter = isEnter && (key.shift || key.sequence === "\x1b[13;2u" || key.sequence === "\x1b[1;2R");
    const isAltEnter = isEnter && key.meta;

    if (isShiftEnter || isAltEnter) {
      multiLineBuffer.push(inputLine);
      inputLine = "";
      inputCursor = 0;
      (rl as any).line = "";
      (rl as any).cursor = 0;
      scheduleRender();
      // Stop event from reaching readline's "line" handler
      (rl as any)._input.pause();
      setImmediate(() => (rl as any)._input.resume());
      return;
    }

    // Ctrl+Arrow fast navigation
    if (key.ctrl) {
      if (key.name === "left") {
        const textBefore = inputLine.slice(0, inputCursor);
        const match = textBefore.match(/(\s*\w+)$/);
        const move = match ? match[1]!.length : 1;
        inputCursor = Math.max(0, inputCursor - move);
        (rl as any).cursor = inputCursor;
        scheduleRender();
      } else if (key.name === "right") {
        const textAfter = inputLine.slice(inputCursor);
        const match = textAfter.match(/^(\w+\s*)/);
        const move = match ? match[1]!.length : 1;
        inputCursor = Math.min(inputLine.length, inputCursor + move);
        (rl as any).cursor = inputCursor;
        scheduleRender();
      }
    }
  });

  process.stdin.on("keypress", (ch, key) => {
    if (!key || destroyed) return;

    // PgUp/PgDn: Node.js uses "prior"/"next" for these keys
    if (key.name === "prior" || key.name === "pageup") {
      scrollOffset += effectiveVH();
      scheduleRender();
      return;
    }
    if (key.name === "next" || key.name === "pagedown") {
      scrollOffset = Math.max(0, scrollOffset - effectiveVH());
      scheduleRender();
      return;
    }
    if (key.name === "escape") {
      scrollOffset = 0;
      unreadCount = 0;
      scheduleRender();
      return;
    }

    // Jump keys: g (top), G (bottom)
    if (!inputLine && multiLineBuffer.length === 0 && key.name === "g") {
      if (key.shift) {
        // G (Shift+G) -> Bottom
        scrollOffset = 0;
        unreadCount = 0;
      } else {
        // g -> Top
        const allLines = getLines();
        const evh = effectiveVH();
        scrollOffset = Math.max(0, allLines.length - evh);
      }
      scheduleRender();
      return;
    }

    // readline's 'keypress' listener fires before ours (registered first inside
    // createInterface), so rl.line is already updated — no setImmediate needed.
    const rlAny      = rl as any;
    inputLine        = rlAny.line   ?? "";
    inputCursor      = rlAny.cursor ?? 0;
    matchingCommands = inputLine.startsWith("/") ? filterCommands(inputLine) : [];
    scheduleRender();
  });

  rl.on("line", (line) => {
    if (line.endsWith("\\")) {
      multiLineBuffer.push(line.slice(0, -1));
      inputLine = "";
      inputCursor = 0;
      (rl as any).line = "";
      (rl as any).cursor = 0;
      scheduleRender();
      return;
    }

    const text = (multiLineBuffer.join("\n") + "\n" + line).trim();
    inputLine        = "";
    inputCursor      = 0;
    multiLineBuffer  = [];
    matchingCommands = [];
    scrollOffset     = 0;
    if (text) submitHandler?.(text);
    scheduleRender();
  });

  rl.on("SIGINT", () => { process.kill(process.pid, "SIGINT"); });

  // ── Resize ───────────────────────────────────────────────────────────────

  process.stdout.on("resize", () => {
    cols = Math.max(40, process.stdout.columns ?? 80);
    rows = Math.max(10, process.stdout.rows ?? 24);
    invalidate();
    scheduleRender();
  });

  // ── ChatUI implementation ─────────────────────────────────────────────────

  function pushMessage(message: ChatMessage): string {
    const id  = message.id ?? createId();
    const rec: MessageRecord = {
      id,
      role:      message.role,
      content:   message.content,
      timestamp: message.timestamp ?? Date.now(),
      transient: message.transient ?? false,
      isLog:     false,
    };
    messages.push(rec);

    if (scrollOffset > 0) {
      // Keep current scroll position stable when new content arrives below
      scrollOffset += renderMessageToLines(rec).length;
      unreadCount++;
    }

    invalidate();
    scheduleRender();
    return id;
  }

  function updateMessage(id: string, patch: Partial<ChatMessage>) {
    const rec = messages.find((m) => m.id === id);
    if (!rec) return;
    if (patch.content   !== undefined) rec.content   = patch.content;
    if (patch.role      !== undefined) rec.role      = patch.role;
    if (patch.transient !== undefined) rec.transient = patch.transient;
    if (patch.timestamp !== undefined) rec.timestamp = patch.timestamp;
    invalidate();
    scheduleRender();
  }

  function removeMessage(id: string) {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx !== -1) { messages.splice(idx, 1); invalidate(); scheduleRender(); }
  }

  function pushLog(stream: "stdout" | "stderr", data: string) {
    messages.push({
      id: createId(), role: "system", content: data.trimEnd(),
      timestamp: Date.now(), transient: false, isLog: true, logStream: stream,
    });
    invalidate();
    scheduleRender();
  }

  function clearMessages() {
    messages.length = 0;
    scrollOffset    = 0;
    invalidate();
    scheduleRender();
  }

  function setStatus(text: string)      { statusText = text; scheduleRender(); }
  function setRuntimeInfo(text: string) { runtimeInfo = text; scheduleRender(); }

  function setTheme(themeName: ThemeName) {
    theme = THEMES[themeName];
    invalidate();
    scheduleRender();
  }

  function onSubmit(handler: (text: string) => void) { submitHandler = handler; }
  function startWatchingIndicator() { /* status text handles this */ }
  function stopWatchingIndicator()  { /* no-op */ }
  function focusInput()             { scheduleRender(); }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    rl.close();
    process.stdout.write(SHOW_CURSOR + EXIT_ALT);
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  logger.debug("UI", "TUI initialised (fixed-layout alternate screen)");
  process.stdout.write(ENTER_ALT + CLEAR_SCREEN + moveTo(1, 1));
  scheduleRender();

  return {
    onSubmit, pushMessage, updateMessage, removeMessage, pushLog,
    clearMessages, setStatus, setRuntimeInfo, setTheme,
    startWatchingIndicator, stopWatchingIndicator, focusInput, destroy,
  };
}
