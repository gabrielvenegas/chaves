import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { logger } from "./logger.js";
import { shield } from "./shield.js";

export type EventType =
  | "file_open"
  | "file_change"
  | "file_create"
  | "file_delete"
  | "idle_start"
  | "idle_end";

export interface ActivityEvent {
  id?: number;
  timestamp: string;
  event_type: EventType;
  file_path: string;
  details?: string;
}

export type MessageRole = "user" | "assistant" | "system";
export type MessageChannel = "chat" | "proactive" | "error" | "info";

export interface StoredMessage {
  id: number;
  timestamp: string;
  role: MessageRole;
  channel: MessageChannel;
  content: string;
  session_id: string | null;
}

export interface StoredChatSummary {
  id: number;
  timestamp: string;
  content: string;
  message_range_start: number;
  message_range_end: number;
}

export interface DiffSnapshot {
  id: number;
  timestamp: string;
  change_count: number;
  prompt: string;
  changes_json: string;
}

export interface StoredFileRecord {
  path: string;
  timestamp: string;
  sha256: string;
  language: string;
  content: string;
  size_bytes: number | null;
  blocked: number;
}

export interface FileSearchResult {
  path: string;
  language: string;
  blocked: boolean;
  snippet: string;
}

export interface ListFileResult {
  path: string;
  language: string;
  blocked: boolean;
  size_bytes: number | null;
  timestamp: string;
}

export interface TerminalEventRecord {
  id: number;
  timestamp: string;
  stream: "stdout" | "stderr";
  data: string;
}

interface RecentMessageOptions {
  limit?: number;
  channel?: MessageChannel;
}

interface UpsertFileInput {
  path: string;
  content: string;
  language: string;
  sizeBytes?: number | null;
  blocked?: boolean;
}

interface SearchFilesOptions {
  query: string;
  limit?: number;
  pathPrefix?: string;
}

interface ListFilesOptions {
  limit?: number;
  pathPrefix?: string;
}

export class Store {
  private db: Database.Database;
  private hasFts = false;
  private readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    const dbPath = join(projectPath, ".chaves.db");

    mkdirSync(projectPath, { recursive: true });

    logger.storeInit(dbPath);

    this.db = new Database(dbPath);
    this.init();
  }

  getProjectPath(): string {
    return this.projectPath;
  }

  private init() {
    logger.debug("STORE", "Creating database tables if not exist...");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        details TEXT
      );
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL,
        event_range_start INTEGER,
        event_range_end INTEGER
      );
      CREATE TABLE IF NOT EXISTS diff_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        change_count INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        changes_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS languages (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        role TEXT NOT NULL,
        channel TEXT NOT NULL,
        content TEXT NOT NULL,
        session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL,
        message_range_start INTEGER,
        message_range_end INTEGER
      );
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        language TEXT NOT NULL,
        content TEXT NOT NULL,
        size_bytes INTEGER,
        blocked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS terminal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        stream TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
      CREATE INDEX IF NOT EXISTS idx_chat_summaries_range ON chat_summaries(message_range_end);
      CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
      CREATE INDEX IF NOT EXISTS idx_terminal_events_timestamp ON terminal_events(timestamp);
    `);

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(path, content);
      `);
      this.hasFts = true;
      logger.debug("STORE", "FTS index enabled for files");
    } catch (error) {
      this.hasFts = false;
      logger.warn("STORE", "FTS not available, falling back to LIKE search");
      logger.debug("STORE", "FTS init error", error);
    }

    logger.debug("STORE", "Database tables initialized");
  }

  addEvent(event: Omit<ActivityEvent, "id" | "timestamp">): ActivityEvent {
    const timestamp = new Date().toISOString();
    const safePath = event.file_path || "";
    const safeDetails = event.details ? shield.sanitize(event.details) : null;

    logger.debug("STORE", `Adding event: ${event.event_type}`, {
      path: safePath,
      details: safeDetails,
    });

    const result = this.db
      .prepare(
        `
      INSERT INTO events (timestamp, event_type, file_path, details)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(timestamp, event.event_type, safePath, safeDetails);

    const savedEvent: ActivityEvent = {
      id: Number(result.lastInsertRowid),
      timestamp,
      event_type: event.event_type,
      file_path: safePath,
      details: safeDetails ?? undefined,
    };

    logger.storeAddEvent(savedEvent);

    return savedEvent;
  }

  getRecentEvents(limit = 50): ActivityEvent[] {
    logger.debug("STORE", `Fetching recent events (limit: ${limit})`);

    const events = this.db
      .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
      .all(limit) as ActivityEvent[];

    logger.debug("STORE", `Retrieved ${events.length} events`);

    return events;
  }

  getEventsSince(eventId: number): ActivityEvent[] {
    logger.debug("STORE", `Fetching events since ID: ${eventId}`);

    const events = this.db
      .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC`)
      .all(eventId) as ActivityEvent[];

    logger.debug(
      "STORE",
      `Retrieved ${events.length} events since ID ${eventId}`,
    );

    return events;
  }

  saveSummary(content: string, eventRangeStart: number, eventRangeEnd: number) {
    const eventCount = eventRangeEnd - eventRangeStart;
    const sanitizedContent = shield.sanitize(content);

    logger.debug(
      "STORE",
      `Saving summary for events ${eventRangeStart} to ${eventRangeEnd}`,
      {
        contentLength: sanitizedContent.length,
        eventCount,
      },
    );

    this.db
      .prepare(
        `
      INSERT INTO summaries (timestamp, content, event_range_start, event_range_end)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(
        new Date().toISOString(),
        sanitizedContent,
        eventRangeStart,
        eventRangeEnd,
      );

    logger.storeSaveSummary(eventCount);
  }

  saveDiffSnapshot(prompt: string, changesJson: string, changeCount: number) {
    const timestamp = new Date().toISOString();
    const safePrompt = shield.sanitize(prompt);
    const safeChanges = shield.sanitize(changesJson);

    logger.debug("STORE", "Saving diff snapshot", {
      changeCount,
      promptLength: safePrompt.length,
    });

    this.db
      .prepare(
        `
      INSERT INTO diff_snapshots (timestamp, change_count, prompt, changes_json)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(timestamp, changeCount, safePrompt, safeChanges);
  }

  getRecentDiffSnapshots(limit = 10): DiffSnapshot[] {
    const rows = this.db
      .prepare(`SELECT * FROM diff_snapshots ORDER BY id DESC LIMIT ?`)
      .all(limit) as DiffSnapshot[];
    return rows.map((row) => ({
      ...row,
      prompt: shield.sanitize(row.prompt),
      changes_json: shield.sanitize(row.changes_json),
    }));
  }

  getDiffSnapshotById(id: number): DiffSnapshot | null {
    const row = this.db
      .prepare(`SELECT * FROM diff_snapshots WHERE id = ? LIMIT 1`)
      .get(id) as DiffSnapshot | undefined;
    if (!row) return null;
    return {
      ...row,
      prompt: shield.sanitize(row.prompt),
      changes_json: shield.sanitize(row.changes_json),
    };
  }

  getLastSummary(): { content: string; event_range_end: number } | null {
    logger.debug("STORE", "Fetching last summary");

    const summary = this.db
      .prepare(`SELECT * FROM summaries ORDER BY id DESC LIMIT 1`)
      .get() as { content: string; event_range_end: number } | null;

    if (summary) {
      logger.debug(
        "STORE",
        `Found summary with ${summary.content.length} chars`,
      );
      return {
        content: shield.sanitize(summary.content),
        event_range_end: summary.event_range_end,
      };
    }

    logger.debug("STORE", "No previous summary found");
    return null;
  }

  addMessage(input: {
    role: MessageRole;
    channel: MessageChannel;
    content: string;
    sessionId?: string;
  }): StoredMessage {
    const timestamp = new Date().toISOString();
    const safeContent = shield.sanitize(input.content);
    const result = this.db
      .prepare(
        `
      INSERT INTO messages (timestamp, role, channel, content, session_id)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(
        timestamp,
        input.role,
        input.channel,
        safeContent,
        input.sessionId ?? null,
      );

    return {
      id: Number(result.lastInsertRowid),
      timestamp,
      role: input.role,
      channel: input.channel,
      content: safeContent,
      session_id: input.sessionId ?? null,
    };
  }

  getRecentMessages(options: RecentMessageOptions = {}): StoredMessage[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 500));

    if (options.channel) {
      const rows = this.db
        .prepare(
          `
        SELECT * FROM (
          SELECT * FROM messages WHERE channel = ? ORDER BY id DESC LIMIT ?
        ) recent
        ORDER BY id ASC
      `,
        )
        .all(options.channel, limit) as StoredMessage[];
      return rows.map((row) => ({ ...row, content: shield.sanitize(row.content) }));
    }

    const rows = this.db
      .prepare(
        `
      SELECT * FROM (
        SELECT * FROM messages ORDER BY id DESC LIMIT ?
      ) recent
      ORDER BY id ASC
    `,
      )
      .all(limit) as StoredMessage[];
    return rows.map((row) => ({ ...row, content: shield.sanitize(row.content) }));
  }

  getMessagesSince(messageId: number, channel?: MessageChannel): StoredMessage[] {
    if (channel) {
      const rows = this.db
        .prepare(
          `
        SELECT * FROM messages
        WHERE id > ? AND channel = ?
        ORDER BY id ASC
      `,
        )
        .all(messageId, channel) as StoredMessage[];
      return rows.map((row) => ({ ...row, content: shield.sanitize(row.content) }));
    }

    const rows = this.db
      .prepare(
        `
      SELECT * FROM messages
      WHERE id > ?
      ORDER BY id ASC
    `,
      )
      .all(messageId) as StoredMessage[];
    return rows.map((row) => ({ ...row, content: shield.sanitize(row.content) }));
  }

  getLastChatSummary(): StoredChatSummary | null {
    const row = this.db
      .prepare(`SELECT * FROM chat_summaries ORDER BY id DESC LIMIT 1`)
      .get() as StoredChatSummary | undefined;
    if (!row) return null;
    return { ...row, content: shield.sanitize(row.content) };
  }

  saveChatSummary(
    content: string,
    messageRangeStart: number,
    messageRangeEnd: number,
  ): StoredChatSummary {
    const timestamp = new Date().toISOString();
    const sanitized = shield.sanitize(content);

    const result = this.db
      .prepare(
        `
      INSERT INTO chat_summaries (timestamp, content, message_range_start, message_range_end)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(timestamp, sanitized, messageRangeStart, messageRangeEnd);

    return {
      id: Number(result.lastInsertRowid),
      timestamp,
      content: sanitized,
      message_range_start: messageRangeStart,
      message_range_end: messageRangeEnd,
    };
  }

  clearContext(): void {
    const tables = [
      "messages",
      "chat_summaries",
      "summaries",
      "diff_snapshots",
      "events",
      "terminal_events",
    ] as const;

    const transaction = this.db.transaction(() => {
      for (const table of tables) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
    });

    transaction();
  }

  upsertFile(input: UpsertFileInput): void {
    const safePath = this.assertSafeRelativePath(input.path);
    const timestamp = new Date().toISOString();
    const flaggedBlocked = Boolean(input.blocked);
    const hasSecret = !flaggedBlocked && shield.hasApiKey(input.content);
    const blocked = flaggedBlocked || hasSecret;
    const safeContent = blocked ? "" : shield.sanitize(input.content);
    const safeLanguage = input.language || "text";
    const sizeBytes = input.sizeBytes ?? null;
    const sha256 = this.hashString(safeContent);

    this.db
      .prepare(
        `
      INSERT INTO files (path, timestamp, sha256, language, content, size_bytes, blocked)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        timestamp = excluded.timestamp,
        sha256 = excluded.sha256,
        language = excluded.language,
        content = excluded.content,
        size_bytes = excluded.size_bytes,
        blocked = excluded.blocked
    `,
      )
      .run(
        safePath,
        timestamp,
        sha256,
        safeLanguage,
        safeContent,
        sizeBytes,
        blocked ? 1 : 0,
      );

    if (!this.hasFts) return;

    try {
      this.db.prepare(`DELETE FROM files_fts WHERE path = ?`).run(safePath);
      if (!blocked) {
        this.db
          .prepare(`INSERT INTO files_fts(path, content) VALUES (?, ?)`)
          .run(safePath, safeContent);
      }
    } catch (error) {
      logger.debug("STORE", "Failed to update FTS row", error);
    }
  }

  deleteFile(path: string): void {
    const safePath = this.assertSafeRelativePath(path);
    this.db.prepare(`DELETE FROM files WHERE path = ?`).run(safePath);
    if (this.hasFts) {
      this.db.prepare(`DELETE FROM files_fts WHERE path = ?`).run(safePath);
    }
  }

  getIndexedFileCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM files`)
      .get() as { count: number };
    return row?.count ?? 0;
  }

  getFile(path: string): StoredFileRecord | null {
    const safePath = this.assertSafeRelativePath(path);
    const row = this.db
      .prepare(`SELECT * FROM files WHERE path = ? LIMIT 1`)
      .get(safePath) as StoredFileRecord | undefined;

    if (!row) return null;

    return {
      ...row,
      content: shield.sanitize(row.content),
    };
  }

  listFiles(options: ListFilesOptions = {}): ListFileResult[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const safePrefix = options.pathPrefix
      ? this.assertSafeRelativePath(options.pathPrefix)
      : null;
    const likePrefix = safePrefix ? `${safePrefix}%` : null;

    const rows = this.db
      .prepare(
        `
      SELECT path, language, blocked, size_bytes, timestamp
      FROM files
      WHERE (? IS NULL OR path LIKE ?)
      ORDER BY path ASC
      LIMIT ?
    `,
      )
      .all(likePrefix, likePrefix, limit) as Array<{
      path: string;
      language: string;
      blocked: number;
      size_bytes: number | null;
      timestamp: string;
    }>;

    return rows.map((row) => ({
      path: row.path,
      language: row.language,
      blocked: row.blocked === 1,
      size_bytes: row.size_bytes,
      timestamp: row.timestamp,
    }));
  }

  searchFiles(options: SearchFilesOptions): FileSearchResult[] {
    const query = options.query.trim();
    if (!query) return [];

    const limit = Math.max(1, Math.min(options.limit ?? 8, 100));
    const safePrefix = options.pathPrefix
      ? this.assertSafeRelativePath(options.pathPrefix)
      : null;
    const likePrefix = safePrefix ? `${safePrefix}%` : null;

    if (this.hasFts) {
      try {
        const rows = this.db
          .prepare(
            `
          SELECT f.path, f.language, f.blocked, substr(f.content, 1, 500) AS snippet
          FROM files_fts
          JOIN files f ON files_fts.path = f.path
          WHERE files_fts MATCH ? AND (? IS NULL OR f.path LIKE ?)
          ORDER BY bm25(files_fts)
          LIMIT ?
        `,
          )
          .all(query, likePrefix, likePrefix, limit) as Array<{
          path: string;
          language: string;
          blocked: number;
          snippet: string;
        }>;

        return rows.map((row) => ({
          path: row.path,
          language: row.language,
          blocked: row.blocked === 1,
          snippet: shield.sanitize(row.snippet ?? ""),
        }));
      } catch (error) {
        logger.debug("STORE", "FTS query failed, falling back to LIKE", error);
      }
    }

    const likeQuery = `%${query}%`;
    const rows = this.db
      .prepare(
        `
      SELECT path, language, blocked, substr(content, 1, 500) AS snippet
      FROM files
      WHERE content LIKE ? AND (? IS NULL OR path LIKE ?)
      ORDER BY timestamp DESC
      LIMIT ?
    `,
      )
      .all(likeQuery, likePrefix, likePrefix, limit) as Array<{
      path: string;
      language: string;
      blocked: number;
      snippet: string;
    }>;

    return rows.map((row) => ({
      path: row.path,
      language: row.language,
      blocked: row.blocked === 1,
      snippet: shield.sanitize(row.snippet ?? ""),
    }));
  }

  addTerminalEvent(event: { stream: "stdout" | "stderr"; data: string }): TerminalEventRecord {
    const timestamp = new Date().toISOString();
    const safeData = shield.sanitize(event.data);

    const result = this.db
      .prepare(`INSERT INTO terminal_events (timestamp, stream, data) VALUES (?, ?, ?)`)
      .run(timestamp, event.stream, safeData);

    // Prune old records every ~500 inserts to keep DB size bounded
    const id = Number(result.lastInsertRowid);
    if (id % 500 === 0) {
      this.db
        .prepare(`DELETE FROM terminal_events WHERE id NOT IN (SELECT id FROM terminal_events ORDER BY id DESC LIMIT 2000)`)
        .run();
    }

    return { id, timestamp, stream: event.stream, data: safeData };
  }

  getRecentTerminalEvents(limit = 100): TerminalEventRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    return this.db
      .prepare(`SELECT * FROM terminal_events ORDER BY id DESC LIMIT ?`)
      .all(safeLimit) as TerminalEventRecord[];
  }

  getModel(): string {
    logger.debug("STORE", "Fetching configured model");

    const config = this.db
      .prepare(`SELECT value FROM config WHERE key = 'summary_model'`)
      .get() as { value: string } | undefined;

    const model = config?.value ?? "anthropic/claude-3.5-haiku";
    logger.debug("STORE", `Using model: ${model}`);

    return model;
  }

  setModel(modelId: string): void {
    logger.debug("STORE", `Setting model to: ${modelId}`);

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO config (key, value)
      VALUES (?, ?)
    `,
      )
      .run("summary_model", modelId);

    logger.debug("STORE", "Model configuration saved");
  }

  getLanguage(): string {
    logger.debug("STORE", "Fetching configured language");

    const config = this.db
      .prepare(`SELECT value FROM config WHERE key = 'response_language'`)
      .get() as { value: string } | undefined;

    const language = config?.value ?? "en";
    logger.debug("STORE", `Using language: ${language}`);

    return language;
  }

  setLanguage(languageCode: string): void {
    logger.debug("STORE", `Setting language to: ${languageCode}`);

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO config (key, value)
      VALUES (?, ?)
    `,
      )
      .run("response_language", languageCode);

    logger.debug("STORE", "Language configuration saved");
  }

  getThinkingEffort(): "low" | "medium" | "high" {
    logger.debug("STORE", "Fetching configured thinking effort");

    const config = this.db
      .prepare(`SELECT value FROM config WHERE key = 'thinking_effort'`)
      .get() as { value: string } | undefined;

    const value = config?.value;
    if (value === "low" || value === "high") {
      logger.debug("STORE", `Using thinking effort: ${value}`);
      return value;
    }

    logger.debug("STORE", "Using thinking effort: medium");
    return "medium";
  }

  setThinkingEffort(effort: "low" | "medium" | "high"): void {
    logger.debug("STORE", `Setting thinking effort to: ${effort}`);

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO config (key, value)
      VALUES (?, ?)
    `,
      )
      .run("thinking_effort", effort);

    logger.debug("STORE", "Thinking effort configuration saved");
  }

  getTheme(): "warm" | "slate" | "forest" {
    logger.debug("STORE", "Fetching configured theme");

    const config = this.db
      .prepare(`SELECT value FROM config WHERE key = 'theme'`)
      .get() as { value: string } | undefined;

    const value = config?.value;
    if (value === "slate" || value === "forest") {
      logger.debug("STORE", `Using theme: ${value}`);
      return value;
    }

    logger.debug("STORE", "Using theme: warm");
    return "warm";
  }

  setTheme(theme: "warm" | "slate" | "forest"): void {
    logger.debug("STORE", `Setting theme to: ${theme}`);

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO config (key, value)
      VALUES (?, ?)
    `,
      )
      .run("theme", theme);

    logger.debug("STORE", "Theme configuration saved");
  }

  getConfig(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM config WHERE key = ? LIMIT 1`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO config (key, value)
      VALUES (?, ?)
    `,
      )
      .run(key, value);
  }

  getConfigInt(
    key: string,
    fallback: number,
    bounds: { min: number; max: number },
  ): number {
    const raw = this.getConfig(key);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < bounds.min) return fallback;
    if (parsed > bounds.max) return fallback;
    return parsed;
  }

  getConfigEnum<T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T,
  ): T {
    const raw = this.getConfig(key);
    if (!raw) return fallback;
    const candidate = raw as T;
    return allowed.includes(candidate) ? candidate : fallback;
  }

  private assertSafeRelativePath(inputPath: string): string {
    const trimmed = inputPath.trim();
    if (!trimmed) {
      throw new Error("Path cannot be empty");
    }

    const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (normalized.startsWith("/") || normalized.includes("\0")) {
      throw new Error("Path must be project-relative");
    }

    const segments = normalized.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new Error("Path traversal is not allowed");
    }

    return segments.filter((segment) => segment.length > 0).join("/");
  }

  private hashString(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
