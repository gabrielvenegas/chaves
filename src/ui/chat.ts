import readline from "readline";
import chalk from "chalk";
import { stripVTControlCharacters } from "util";
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
  onThemeChange(handler: (theme: ThemeName) => void): void;
  onRefresh(handler: () => void): void;
  onFileSearch(handler: (query: string) => Promise<string[]>): void;
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

interface MessageRecord {
  id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  transient: boolean;
  isLog: boolean;
  logStream?: "stdout" | "stderr";
}

const ESC = "\x1b";
const moveTo = (row: number, col: number): string => `${ESC}[${row};${col}H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ENTER_ALT = `${ESC}[?1049h`;
const EXIT_ALT = `${ESC}[?1049l`;
const CLEAR_SCREEN = `${ESC}[2J`;

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
      if (match) {
        index += match[0].length;
        continue;
      }
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
    if (visibleLength(current + part) <= width) {
      current += part;
      continue;
    }
    if (current.trim()) {
      lines.push(current.trimEnd());
      current = part.trimStart();
      continue;
    }
    let remainder = part;
    while (visibleLength(remainder) > width) {
      let vis = 0;
      let idx = 0;
      while (idx < remainder.length && vis < width) {
        if (remainder[idx] === "\u001b") {
          const m = /^\u001b\[[0-9;]*m/.exec(remainder.slice(idx));
          if (m) {
            idx += m[0].length;
            continue;
          }
        }
        vis++;
        idx++;
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
      wrapLine(line, Math.max(12, width - indent.length)).map((w) => `${indent}${w}`),
    )
    .join("\n");
}

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

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

const ROLE_LABEL: Record<ChatMessageRole, string> = {
  user: "YOU",
  assistant: "CHAVES",
  system: "SYSTEM",
  progress: "STATUS",
};

function roleColor(role: ChatMessageRole, theme: ThemeDefinition): string {
  return {
    user: theme.user,
    assistant: theme.assistant,
    system: theme.system,
    progress: theme.progress,
  }[role];
}

export function createChatUI(options: ChatUIOptions = {}): ChatUI {
  let theme = THEMES[options.theme ?? "warm"];
  let statusText = options.initialStatus ?? "Watching…";
  let runtimeInfo = "";
  let submitHandler: ((text: string) => void) | null = null;
  let themeChangeHandler: ((theme: ThemeName) => void) | null = null;
  let refreshHandler: (() => void) | null = null;
  let fileSearchHandler: ((query: string) => Promise<string[]>) | null = null;
  let destroyed = false;

  let cols = Math.max(40, process.stdout.columns ?? 80);
  let rows = Math.max(10, process.stdout.rows ?? 24);

  const messages: MessageRecord[] = [];
  let cachedLines: string[] | null = null;
  let cachedCols = 0;

  let scrollOffset = 0;
  let unreadCount = 0;
  let draftLines = [""];
  let cursorRow = 0;
  let cursorCol = 0;
  let matchingCommands: readonly ChatCommandDefinition[] = [];
  let matchingFiles: string[] = [];
  let selectedPickerIndex = 0;
  let renderPending = false;
  let lastRenderTime = 0;

  const HEADER = 3;

  function currentLine(): string {
    return draftLines[cursorRow] ?? "";
  }

  function hasDraftContent(): boolean {
    return draftLines.some((line) => line.length > 0);
  }

  function isDraftBlank(): boolean {
    return draftLines.length === 1 && draftLines[0] === "";
  }

  async function resetDraft() {
    draftLines = [""];
    cursorRow = 0;
    cursorCol = 0;
    await updateMatchingCommands();
  }

  function clampCursor() {
    cursorRow = Math.max(0, Math.min(cursorRow, draftLines.length - 1));
    cursorCol = Math.max(0, Math.min(cursorCol, currentLine().length));
  }

  async function updateMatchingCommands() {
    const line = currentLine();
    const textBeforeCursor = line.slice(0, cursorCol);

    // Command handling (must be at start of first line)
    if (cursorRow === 0 && line.startsWith("/")) {
      const prevCount = matchingCommands.length;
      matchingCommands = filterCommands(line);
      matchingFiles = [];
      if (matchingCommands.length !== prevCount) {
        selectedPickerIndex = 0;
      }
      return;
    }

    // File handling (starts with @ anywhere)
    const atMatch = textBeforeCursor.match(/@(\S*)$/);
    if (atMatch && fileSearchHandler) {
      const query = atMatch[1] || "";
      const results = await fileSearchHandler(query);
      const prevCount = matchingFiles.length;
      matchingFiles = results;
      matchingCommands = [];
      if (matchingFiles.length !== prevCount) {
        selectedPickerIndex = 0;
      }
    } else {
      matchingCommands = [];
      matchingFiles = [];
      selectedPickerIndex = 0;
    }
  }

  async function insertText(text: string) {
    const segments = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const line = currentLine();
    const before = line.slice(0, cursorCol);
    const after = line.slice(cursorCol);

    if (segments.length === 1) {
      draftLines[cursorRow] = before + segments[0] + after;
      cursorCol += segments[0]!.length;
      await updateMatchingCommands();
      return;
    }

    const nextLines = [
      before + (segments[0] ?? ""),
      ...segments.slice(1, -1),
      `${segments.at(-1) ?? ""}${after}`,
    ];
    draftLines.splice(cursorRow, 1, ...nextLines);
    cursorRow += segments.length - 1;
    cursorCol = (segments.at(-1) ?? "").length;
    await updateMatchingCommands();
  }

  async function insertNewline() {
    await insertText("\n");
  }

  async function deleteBackward() {
    if (cursorCol > 0) {
      const line = currentLine();
      draftLines[cursorRow] = line.slice(0, cursorCol - 1) + line.slice(cursorCol);
      cursorCol--;
      await updateMatchingCommands();
      return;
    }

    if (cursorRow === 0) return;

    const previous = draftLines[cursorRow - 1] ?? "";
    const line = currentLine();
    draftLines.splice(cursorRow, 1);
    cursorRow--;
    cursorCol = previous.length;
    draftLines[cursorRow] = previous + line;
    await updateMatchingCommands();
  }

  async function deleteForward() {
    const line = currentLine();
    if (cursorCol < line.length) {
      draftLines[cursorRow] = line.slice(0, cursorCol) + line.slice(cursorCol + 1);
      await updateMatchingCommands();
      return;
    }

    if (cursorRow >= draftLines.length - 1) return;

    const next = draftLines[cursorRow + 1] ?? "";
    draftLines[cursorRow] = line + next;
    draftLines.splice(cursorRow + 1, 1);
    await updateMatchingCommands();
  }

  function moveLeft(ctrl = false) {
    if (ctrl) {
      const textBefore = currentLine().slice(0, cursorCol);
      const match = textBefore.match(/(\s*\w+)$/);
      cursorCol = Math.max(0, cursorCol - (match ? match[1]!.length : 1));
      return;
    }

    if (cursorCol > 0) {
      cursorCol--;
      return;
    }

    if (cursorRow > 0) {
      cursorRow--;
      cursorCol = currentLine().length;
    }
  }

  function moveRight(ctrl = false) {
    const line = currentLine();
    if (ctrl) {
      const textAfter = line.slice(cursorCol);
      const match = textAfter.match(/^(\w+\s*)/);
      cursorCol = Math.min(line.length, cursorCol + (match ? match[1]!.length : 1));
      return;
    }

    if (cursorCol < line.length) {
      cursorCol++;
      return;
    }

    if (cursorRow < draftLines.length - 1) {
      cursorRow++;
      cursorCol = 0;
    }
  }

  function moveUp() {
    cursorRow = Math.max(0, cursorRow - 1);
    cursorCol = Math.min(cursorCol, currentLine().length);
  }

  function moveDown() {
    cursorRow = Math.min(draftLines.length - 1, cursorRow + 1);
    cursorCol = Math.min(cursorCol, currentLine().length);
  }

  function submitDraft() {
    const text = draftLines.join("\n");
    resetDraft();
    scrollOffset = 0;
    if (text.trim()) submitHandler?.(text);
  }

  function insertNewlineAtCursor(removeTrailingBackslash = false) {
    if (removeTrailingBackslash) {
      const line = currentLine();
      if (cursorCol > 0 && line[cursorCol - 1] === "\\") {
        draftLines[cursorRow] = line.slice(0, cursorCol - 1) + line.slice(cursorCol);
        cursorCol--;
      }
    }
    insertNewline();
  }

  function getFooterRows() {
    return 5 + Math.max(0, draftLines.length - 1);
  }

  function vpStart() { return HEADER + 1; }
  function vpEnd() { return rows - getFooterRows(); }
  function inputStartRow() { return vpEnd() + 2; }

  function pickerRowCount() {
    const count = matchingCommands.length || matchingFiles.length;
    return count > 0 ? 1 + Math.min(count, 10) : 0;
  }

  function effectiveVH() {
    return Math.max(1, vpEnd() - vpStart() + 1 - pickerRowCount());
  }

  function iw() { return cols - 2; }

  function renderMessageToLines(msg: MessageRecord): string[] {
    const width = iw();

    if (msg.isLog) {
      const tag = msg.logStream === "stderr"
        ? chalk.hex(theme.system)("err")
        : chalk.hex(theme.muted)("out");
      return wrapLine(`  ${tag}  ${chalk.hex(theme.muted)(msg.content.trimEnd())}`, width);
    }

    const lines: string[] = [""];
    const label = chalk.hex(roleColor(msg.role, theme)).bold(ROLE_LABEL[msg.role]);
    const ts = chalk.hex(theme.muted)(formatTimestamp(msg.timestamp));
    lines.push(`  ${label}  ${ts}`);

    if (msg.content.trim() === "" && msg.transient) {
      lines.push(chalk.hex(theme.muted)("  …"));
    } else {
      const suffix = msg.transient ? ` ${chalk.hex(theme.muted)("▋")}` : "";
      const raw = msg.content.trimEnd() + suffix;
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
      cachedCols = cols;
    }
    return cachedLines;
  }

  function invalidate() {
    cachedLines = null;
  }

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
    const dot = chalk.hex(theme.muted)("·");
    const status = chalk.hex(theme.status).bold(statusText.replace(/\s+/g, " ").trim());
    const rt = runtimeInfo ? `  ${dot}  ${chalk.hex(theme.muted)(runtimeInfo)}` : "";
    return truncateVisible(
      `  ${chalk.hex(theme.assistant).bold("chaves")}  ${dot}  ${status}${rt}`,
      iw(),
    );
  }

  function renderDraftLine(line: string, row: number): string {
    const prefix = row === 0
      ? `  ${chalk.hex(theme.assistant).bold("›")} `
      : `  ${chalk.hex(theme.muted)("·")} `;
    const available = Math.max(1, iw() - 4);

    if (isDraftBlank() && row === 0) {
      return prefix + truncateVisible(chalk.hex(theme.muted)("Write a message…"), available);
    }

    const isCursorLine = row === cursorRow;
    const viewStart = isCursorLine ? Math.max(0, cursorCol - available) : 0;
    return prefix + (line.slice(viewStart, viewStart + available) || "");
  }

  function cursorPosition(): { row: number; col: number } {
    const available = Math.max(1, iw() - 4);
    const viewStart = Math.max(0, cursorCol - available);
    return {
      row: inputStartRow() + cursorRow,
      col: 6 + (cursorCol - viewStart),
    };
  }

  function renderAll() {
    renderPending = false;
    if (destroyed) return;
    lastRenderTime = Date.now();

    if (rows < 10 || cols < 30) {
      process.stdout.write(
        HIDE_CURSOR + moveTo(1, 1) + CLEAR_SCREEN + moveTo(1, 1) + "Terminal too small." + SHOW_CURSOR,
      );
      return;
    }

    const evh = effectiveVH();
    const pRows = pickerRowCount();
    const allLines = getLines();
    const total = allLines.length;

    let sliceStart = 0;
    if (total > evh) {
      const maxOff = total - evh;
      scrollOffset = Math.max(0, Math.min(scrollOffset, maxOff));
      sliceStart = maxOff - scrollOffset;
    } else {
      scrollOffset = 0;
    }

    if (scrollOffset === 0) unreadCount = 0;

    const buf: string[] = [HIDE_CURSOR, moveTo(1, 1)];

    buf.push(topBorder(options.title ?? "CHAVES", cols, theme), "\r\n");
    buf.push(contentRow(subtitleText(), cols, theme), "\r\n");
    buf.push(midBorder(null, cols, theme), "\r\n");

    const vpContentEnd = vpEnd() - pRows;
    for (let row = vpStart(); row <= vpContentEnd; row++) {
      const lineIdx = sliceStart + (row - vpStart());
      const line = lineIdx < total ? (allLines[lineIdx] ?? "") : "";

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

    if (pRows > 0) {
      const pickerLabel = matchingCommands.length > 0 ? "COMMANDS" : "FILES";
      buf.push(midBorder(pickerLabel, cols, theme), "\r\n");
      
      const items = matchingCommands.length > 0 ? matchingCommands : matchingFiles;
      // Ensure selected index stays within bounds if list changed
      selectedPickerIndex = Math.min(selectedPickerIndex, items.length - 1);
      if (selectedPickerIndex < 0 && items.length > 0) selectedPickerIndex = 0;

      // Show up to 10 items
      const viewItems = items.slice(0, 10);
      for (let i = 0; i < viewItems.length; i++) {
        const item = viewItems[i]!;
        const isSelected = i === selectedPickerIndex;
        
        let rowText = "";
        if (typeof item === "string") {
          // File path
          rowText = isSelected ? chalk.bgHex(theme.track).bold(` > ${item}`) : `   ${item}`;
        } else {
          // Command definition
          const name = item.command.padEnd(14);
          const desc = item.description;
          rowText = isSelected 
            ? chalk.bgHex(theme.track).bold(` > ${name}  ${desc}`) 
            : `   ${chalk.hex(theme.assistant).bold(name)}  ${chalk.hex(theme.muted)(desc)}`;
        }
        buf.push(contentRow(truncateVisible(rowText, iw()), cols, theme), "\r\n");
      }
    }

    buf.push(midBorder("INPUT", cols, theme), "\r\n");
    for (let row = 0; row < draftLines.length; row++) {
      buf.push(contentRow(renderDraftLine(draftLines[row] ?? "", row), cols, theme), "\r\n");
    }
    buf.push(midBorder(null, cols, theme), "\r\n");
    buf.push(contentRow(statusText_(), cols, theme), "\r\n");
    buf.push(bottomBorder(cols, theme));

    clampCursor();
    const cursor = cursorPosition();
    buf.push(moveTo(cursor.row, isDraftBlank() ? 6 : cursor.col));
    buf.push(SHOW_CURSOR);

    process.stdout.write(buf.join(""));
  }

  function scheduleRender() {
    if (renderPending || destroyed) return;
    renderPending = true;

    const now = Date.now();
    const elapsed = now - lastRenderTime;
    const minDelay = 33;

    if (elapsed >= minDelay) {
      setImmediate(renderAll);
    } else {
      setTimeout(renderAll, minDelay - elapsed);
    }
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  async function onKeypress(ch: string | undefined, key: readline.Key) {
    if (!key || destroyed) return;

    if (key.ctrl && key.name === "c") {
      process.kill(process.pid, "SIGINT");
      return;
    }

    if (key.ctrl && key.name === "k") {
      await resetDraft();
      scheduleRender();
      return;
    }

    if (key.ctrl && key.name === "r") {
      refreshHandler?.();
      return;
    }

    if (key.ctrl && key.name === "t") {
      const allThemes = Object.keys(THEMES) as ThemeName[];
      const currentIndex = allThemes.indexOf(theme.name);
      const nextIndex = (currentIndex + 1) % allThemes.length;
      const nextTheme = allThemes[nextIndex]!;
      setTheme(nextTheme);
      themeChangeHandler?.(nextTheme);
      return;
    }

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

    const pCount = matchingCommands.length || matchingFiles.length;

    if (isDraftBlank() && key.name === "g") {
      if (key.shift) {
        scrollOffset = 0;
        unreadCount = 0;
      } else {
        const allLines = getLines();
        const evh = effectiveVH();
        scrollOffset = Math.max(0, allLines.length - evh);
      }
      scheduleRender();
      return;
    }

    if ((key.name === "up" || key.name === "down") && isDraftBlank()) {
      if (key.name === "up") {
        scrollOffset += 1;
      } else {
        scrollOffset = Math.max(0, scrollOffset - 1);
      }
      scheduleRender();
      return;
    }

    // Picker Navigation
    if (pCount > 0 && (key.name === "up" || key.name === "down")) {
      if (key.name === "up") {
        selectedPickerIndex = (selectedPickerIndex - 1 + pCount) % pCount;
      } else {
        selectedPickerIndex = (selectedPickerIndex + 1) % pCount;
      }
      scheduleRender();
      return;
    }

    const isEnter = key.name === "return" || key.name === "enter";
    const isTab = key.name === "tab";

    // Picker Selection
    if (pickerRowCount() > 0 && (isEnter || isTab)) {
      if (matchingCommands.length > 0) {
        const cmd = matchingCommands[selectedPickerIndex]!;
        const currentText = (draftLines[0] || "").trim();
        
        // If the user presses Enter and the command is already fully typed, SUBMIT IT
        if (isEnter && currentText === cmd.command) {
          submitDraft();
          scheduleRender();
          return;
        }

        // Otherwise, complete the command
        draftLines[0] = cmd.command + " ";
        cursorCol = draftLines[0].length;
      } else if (matchingFiles.length > 0) {
        const file = matchingFiles[selectedPickerIndex]!;
        const line = currentLine();
        const textBeforeCursor = line.slice(0, cursorCol);
        const atMatch = textBeforeCursor.match(/@(\S*)$/);
        if (atMatch) {
          const beforeAt = textBeforeCursor.slice(0, atMatch.index);
          const afterCursor = line.slice(cursorCol);
          draftLines[cursorRow] = beforeAt + "@" + file + " " + afterCursor;
          cursorCol = beforeAt.length + file.length + 2; // +1 for @, +1 for space
        }
      }
      await updateMatchingCommands();
      scheduleRender();
      return;
    }

    const isShiftEnter = isEnter && (key.shift || key.sequence === "\x1b[13;2u" || key.sequence === "\x1b[1;2R");
    const isAltEnter = isEnter && key.meta;
    const isCtrlJ = key.ctrl && key.name === "j";
    const isCtrlO = key.ctrl && key.name === "o";
    const shouldContinueLine =
      isEnter &&
      cursorCol > 0 &&
      currentLine()[cursorCol - 1] === "\\";

    if (isShiftEnter || isAltEnter || isCtrlJ || isCtrlO || shouldContinueLine) {
      await insertNewlineAtCursor(shouldContinueLine);
      scheduleRender();
      return;
    }

    if (isEnter) {
      submitDraft();
      scheduleRender();
      return;
    }

    switch (key.name) {
      case "left":
        moveLeft(Boolean(key.ctrl));
        await updateMatchingCommands();
        scheduleRender();
        return;
      case "right":
        moveRight(Boolean(key.ctrl));
        await updateMatchingCommands();
        scheduleRender();
        return;
      case "up":
        moveUp();
        await updateMatchingCommands();
        scheduleRender();
        return;
      case "down":
        moveDown();
        await updateMatchingCommands();
        scheduleRender();
        return;
      case "backspace":
        await deleteBackward();
        scheduleRender();
        return;
      case "delete":
        await deleteForward();
        scheduleRender();
        return;
      case "home":
        cursorCol = 0;
        await updateMatchingCommands();
        scheduleRender();
        return;
      case "end":
        cursorCol = currentLine().length;
        await updateMatchingCommands();
        scheduleRender();
        return;
      default:
        break;
    }

    if (typeof ch === "string" && ch.length > 0 && !key.ctrl && !key.meta) {
      await insertText(ch);
      scheduleRender();
    }
  }

  process.stdin.on("keypress", onKeypress);

  process.stdout.on("resize", () => {
    cols = Math.max(40, process.stdout.columns ?? 80);
    rows = Math.max(10, process.stdout.rows ?? 24);
    invalidate();
    scheduleRender();
  });

  function pushMessage(message: ChatMessage): string {
    const id = message.id ?? createId();
    const rec: MessageRecord = {
      id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp ?? Date.now(),
      transient: message.transient ?? false,
      isLog: false,
    };
    messages.push(rec);

    if (scrollOffset > 0) {
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
    if (patch.content !== undefined) rec.content = patch.content;
    if (patch.role !== undefined) rec.role = patch.role;
    if (patch.transient !== undefined) rec.transient = patch.transient;
    if (patch.timestamp !== undefined) rec.timestamp = patch.timestamp;
    invalidate();
    scheduleRender();
  }

  function removeMessage(id: string) {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx !== -1) {
      messages.splice(idx, 1);
      invalidate();
      scheduleRender();
    }
  }

  function pushLog(stream: "stdout" | "stderr", data: string) {
    messages.push({
      id: createId(),
      role: "system",
      content: data.trimEnd(),
      timestamp: Date.now(),
      transient: false,
      isLog: true,
      logStream: stream,
    });
    invalidate();
    scheduleRender();
  }

  function clearMessages() {
    messages.length = 0;
    scrollOffset = 0;
    invalidate();
    scheduleRender();
  }

  function setStatus(text: string) {
    statusText = text;
    scheduleRender();
  }

  function setRuntimeInfo(text: string) {
    runtimeInfo = text;
    scheduleRender();
  }

  function setTheme(themeName: ThemeName) {
    theme = THEMES[themeName];
    invalidate();
    scheduleRender();
  }

  function onSubmit(handler: (text: string) => void) {
    submitHandler = handler;
  }

  function onThemeChange(handler: (theme: ThemeName) => void) {
    themeChangeHandler = handler;
  }

  function onRefresh(handler: () => void) {
    refreshHandler = handler;
  }

  function onFileSearch(handler: (query: string) => Promise<string[]>) {
    fileSearchHandler = handler;
  }

  function startWatchingIndicator() {}
  function stopWatchingIndicator() {}
  function focusInput() {
    scheduleRender();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    process.stdin.off("keypress", onKeypress);
    try {
      process.stdin.setRawMode(false);
    } catch {
      // ignore
    }
    process.stdout.write(SHOW_CURSOR + EXIT_ALT);
  }

  logger.debug("UI", "TUI initialised (fixed-layout alternate screen)");
  process.stdout.write(ENTER_ALT + CLEAR_SCREEN + moveTo(1, 1));
  scheduleRender();

  return {
    onSubmit,
    onThemeChange,
    onRefresh,
    onFileSearch,
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
