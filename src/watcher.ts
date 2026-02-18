import chokidar from "chokidar";
import { EventEmitter } from "events";
import { relative } from "path";
import { logger } from "./logger.js";
import { DiffTracker, type FileChange } from "./diff-tracker.js";
import type { EventType } from "./store.js";

export interface WatcherEvent {
  type: EventType;
  path: string;
  details?: string;
  change?: FileChange | null;
}

export class Watcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private isIdle = false;
  private readonly idleThreshold = 30_000;
  private diffTracker: DiffTracker;

  constructor(private projectPath: string) {
    super();
    this.diffTracker = new DiffTracker(projectPath);
    logger.debug("WATCHER", `Watcher constructed for: ${projectPath}`);
  }

  start() {
    const ignored = [/node_modules/, /\.git/, /\.chaves\.db/, /dist/, /\.next/];

    logger.watcherStart(this.projectPath);
    logger.debug(
      "WATCHER",
      `Ignored patterns:`,
      ignored.map((r) => r.toString()),
    );

    this.watcher = chokidar.watch(this.projectPath, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher
      .on("add", (path) => {
        void this.handleEvent("file_create", path);
      })
      .on("change", (path) => {
        void this.handleEvent("file_change", path);
      })
      .on("unlink", (path) => {
        void this.handleEvent("file_delete", path);
      })
      .on("ready", () => {
        logger.info("WATCHER", "✅ Watcher ready and listening for changes");
      })
      .on("error", (error) => {
        logger.error("WATCHER", "❌ Watcher error:", error);
      });

    this.resetIdleTimer();
  }

  private async handleEvent(type: EventType, fullPath: string) {
    const path = relative(this.projectPath, fullPath);

    logger.watcherEvent(type, path);
    logger.debug("WATCHER", `Full path: ${fullPath}`);

    const change = await this.diffTracker.handleEvent(type, fullPath);

    if (this.isIdle) {
      this.isIdle = false;
      logger.watcherIdle(false);
      this.emit("event", { type: "idle_end", path: "", details: "" });
      logger.debug("WATCHER", `Emitted idle_end event`);
    }
    this.resetIdleTimer();

    switch (type) {
      case "file_create":
        logger.fileCreate(path);
        break;
      case "file_change":
        logger.fileWrite(path);
        break;
      case "file_delete":
        logger.fileDelete(path);
        break;
    }

    this.emit("event", { type, path, change } as WatcherEvent);
    logger.debug("WATCHER", `Emitted event: ${type} for ${path}`);

    if (this.diffTracker.pendingCount > 10) {
      this.triggerSummarization();
    }
  }

  private resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      logger.debug("WATCHER", "Idle timer reset");
    }

    this.idleTimer = setTimeout(() => {
      this.isIdle = true;
      logger.watcherIdle(true);
      this.emit("event", {
        type: "idle_start",
        path: "",
        details: "No activity detected",
      });
      logger.debug("WATCHER", "Emitted idle_start event");
      this.triggerSummarization();
    }, this.idleThreshold);

    logger.debug("WATCHER", `Idle timer set for ${this.idleThreshold}ms`);
  }

  private triggerSummarization() {
    const changes = this.diffTracker.flushChanges();

    if (changes.length === 0) return;

    const prompt = this.diffTracker.formatForLLM(changes);

    this.emit("summarize", {
      type: "summarize",
      changes,
      prompt,
      timestamp: Date.now(),
    });
  }

  stop() {
    logger.info("WATCHER", "🛑 Stopping watcher...");

    if (this.diffTracker.hasPendingChanges) {
      this.triggerSummarization();
    }

    if (this.watcher) {
      this.watcher.close();
      logger.debug("WATCHER", "Chokidar watcher closed");
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      logger.debug("WATCHER", "Idle timer cleared");
    }

    logger.info("WATCHER", "✅ Watcher stopped");
  }
}
