import chalk from "chalk";

export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

export class Logger {
  private static instance: Logger;
  private enabled: boolean = true;
  private debugMode: boolean = false;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  setDebugMode(enabled: boolean) {
    this.debugMode = enabled;
  }

  private formatTimestamp(): string {
    const now = new Date();
    const time = now.toLocaleTimeString();
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    return chalk.dim(`[${time}.${ms}]`);
  }

  private formatLevel(level: LogLevel): string {
    const colors: Record<LogLevel, typeof chalk.white> = {
      [LogLevel.DEBUG]: chalk.gray,
      [LogLevel.INFO]: chalk.blue,
      [LogLevel.WARN]: chalk.yellow,
      [LogLevel.ERROR]: chalk.red,
    };
    return colors[level](level.padEnd(5));
  }

  private log(level: LogLevel, category: string, message: string, data?: any) {
    if (!this.enabled) return;
    if (level === LogLevel.DEBUG && !this.debugMode) return;

    const timestamp = this.formatTimestamp();
    const levelStr = this.formatLevel(level);
    const categoryStr = chalk.magenta(`[${category}]`);

    let output = `${timestamp} ${levelStr} ${categoryStr} ${message}`;

    if (data !== undefined) {
      if (typeof data === "object") {
        output += "\n" + chalk.dim(JSON.stringify(data, null, 2));
      } else {
        output += " " + chalk.dim(String(data));
      }
    }

    console.log(output);
  }

  debug(category: string, message: string, data?: any) {
    this.log(LogLevel.DEBUG, category, message, data);
  }

  info(category: string, message: string, data?: any) {
    this.log(LogLevel.INFO, category, message, data);
  }

  warn(category: string, message: string, data?: any) {
    this.log(LogLevel.WARN, category, message, data);
  }

  error(category: string, message: string, data?: any) {
    this.log(LogLevel.ERROR, category, message, data);
  }

  fileOpen(filePath: string) {
    this.debug("FILE", `📂 Opening file: ${filePath}`);
  }

  fileRead(filePath: string, size?: number) {
    const sizeInfo = size ? ` (${size} bytes)` : "";
    this.debug("FILE", `📖 Read file: ${filePath}${sizeInfo}`);
  }

  fileWrite(filePath: string, size?: number) {
    const sizeInfo = size ? ` (${size} bytes)` : "";
    this.debug("FILE", `✏️  Writing file: ${filePath}${sizeInfo}`);
  }

  fileClose(filePath: string) {
    this.debug("FILE", `📁 Closed file: ${filePath}`);
  }

  fileCreate(filePath: string) {
    this.debug("FILE", `📄 Created file: ${filePath}`);
  }

  fileDelete(filePath: string) {
    this.debug("FILE", `🗑️  Deleted file: ${filePath}`);
  }

  watcherStart(path: string) {
    this.debug("WATCHER", `👀 Starting watcher on: ${path}`);
  }

  watcherEvent(eventType: string, filePath: string) {
    this.debug("WATCHER", `🔔 Event: ${eventType} - ${filePath}`);
  }

  watcherIdle(state: boolean) {
    const stateStr = state ? "STARTED" : "ENDED";
    this.debug("WATCHER", `💤 Idle ${stateStr}`);
  }

  storeInit(dbPath: string) {
    this.debug("STORE", `🗄️  Initializing database: ${dbPath}`);
  }

  storeAddEvent(event: any) {
    this.debug("STORE", `💾 Saving event #${event.id}`, {
      type: event.event_type,
      path: event.file_path,
    });
  }

  storeSaveSummary(eventCount: number) {
    this.debug("STORE", `📝 Saved summary for ${eventCount} events`);
  }

  aiRequest(promptLength: number) {
    this.debug("AI", `🤖 Sending request (${promptLength} chars)`);
  }

  aiResponse(responseLength: number) {
    this.debug("AI", `✅ Received response (${responseLength} chars)`);
  }

  aiError(error: any) {
    this.error("AI", `❌ Request failed`, error);
  }

  appStart(projectPath: string) {
    this.info("APP", `⚡ CHAVES starting`);
    this.info("APP", `📁 Project: ${projectPath}`);
  }

  appStop() {
    this.info("APP", `👋 CHAVES shutting down`);
  }
}

export const logger = Logger.getInstance();
