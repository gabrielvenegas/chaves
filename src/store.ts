import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync } from "fs";
import { logger } from "./logger.js";

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

export class Store {
  private db: Database.Database;

  constructor(projectPath: string) {
    const dbPath = join(projectPath, ".chaves.db");

    // Ensure the directory exists before creating the database
    const dbDir = projectPath;
    mkdirSync(dbDir, { recursive: true });

    logger.storeInit(dbPath);

    this.db = new Database(dbPath);
    this.init();
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
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS languages (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);

    logger.debug("STORE", "Database tables initialized");
  }

  addEvent(event: Omit<ActivityEvent, "id" | "timestamp">): ActivityEvent {
    const timestamp = new Date().toISOString();

    logger.debug("STORE", `Adding event: ${event.event_type}`, {
      path: event.file_path,
      details: event.details,
    });

    const stmt = this.db.prepare(`
      INSERT INTO events (timestamp, event_type, file_path, details)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(
      timestamp,
      event.event_type,
      event.file_path,
      event.details ?? null,
    );

    const savedEvent: ActivityEvent = {
      id: result.lastInsertRowid as number,
      timestamp,
      ...event,
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

    logger.debug(
      "STORE",
      `Saving summary for events ${eventRangeStart} to ${eventRangeEnd}`,
      {
        contentLength: content.length,
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
      .run(new Date().toISOString(), content, eventRangeStart, eventRangeEnd);

    logger.storeSaveSummary(eventCount);
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
    } else {
      logger.debug("STORE", "No previous summary found");
    }

    return summary;
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

    logger.debug("STORE", "✅ Model configuration saved");
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

    logger.debug("STORE", "✅ Language configuration saved");
  }
}
