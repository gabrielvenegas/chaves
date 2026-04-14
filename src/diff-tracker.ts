import { readFile, stat } from "fs/promises";
import { createTwoFilesPatch } from "diff";
import { relative } from "path";
import type { EventType } from "./store.js";
import { logger } from "./logger.js";
import { shield } from "./shield.js";
import { detectLanguage, isBinaryPath } from "./file-rules.js";

export interface FileChange {
  path: string;
  type: "added" | "modified" | "deleted";
  before?: string;
  after?: string;
  diff?: string;
  timestamp: number;
  language?: string;
  blocked?: boolean;
}

export class DiffTracker {
  constructor(private projectPath?: string) {}

  private cache = new Map<string, { content: string; hash: string }>(); // path -> content + hash
  private pending = new Map<string, FileChange>(); // path -> latest change
  private readonly maxFileSize = 1024 * 1024; // 1MB limit

  private computeHash(content: string): string {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private normalizePath(fullPath: string): string {
    if (!this.projectPath) return fullPath;
    return relative(this.projectPath, fullPath);
  }

  async handleEvent(
    type: EventType,
    fullPath: string,
  ): Promise<FileChange | null> {
    // Block sensitive files immediately
    if (shield.isSensitiveFile(fullPath)) {
      return null;
    }

    // Skip binary files
    if (isBinaryPath(fullPath)) {
      logger.debug("DIFF", `Skipping binary file: ${fullPath}`);
      return null;
    }

    try {
      switch (type) {
        case "file_create":
          return await this.handleCreate(fullPath);
        case "file_change":
          return await this.handleModify(fullPath);
        case "file_delete":
          return this.handleDelete(fullPath);
        default:
          return null;
      }
    } catch (error) {
      logger.error("DIFF", `Failed to process ${fullPath}:`, error);
      return null;
    }
  }

  private async handleCreate(fullPath: string): Promise<FileChange | null> {
    const content = await this.readFileSafe(fullPath);
    if (content === null) return null;
    const displayPath = this.normalizePath(fullPath);

    if (shield.hasApiKey(content)) {
      return {
        path: displayPath,
        type: "added",
        after: "",
        timestamp: Date.now(),
        language: detectLanguage(fullPath),
        blocked: true,
      };
    }

    const sanitized = shield.sanitize(content);
    const hash = this.computeHash(sanitized);
    const cached = this.cache.get(fullPath);

    if (cached?.hash === hash) return null;

    this.cache.set(fullPath, { content: sanitized, hash });

    const existing = this.pending.get(fullPath);
    const change: FileChange = {
      path: displayPath,
      type: "added",
      after: sanitized,
      timestamp: Date.now(),
      language: detectLanguage(fullPath),
    };

    // If it was already in pending (e.g. modified then deleted then added?), 
    // we keep it as 'added' with new content
    this.pending.set(fullPath, change);
    return change;
  }

  private async handleModify(fullPath: string): Promise<FileChange | null> {
    const cached = this.cache.get(fullPath);
    const diskContent = await this.readFileSafe(fullPath);

    if (diskContent === null) return null;
    const sanitized = shield.sanitize(diskContent);
    const hash = this.computeHash(sanitized);

    if (cached?.hash === hash) return null;

    const displayPath = this.normalizePath(fullPath);

    if (shield.hasApiKey(sanitized)) {
      this.cache.delete(fullPath);
      return {
        path: displayPath,
        type: "modified",
        after: "",
        timestamp: Date.now(),
        language: detectLanguage(fullPath),
        blocked: true,
      };
    }

    // Check if we have a pending change to merge with
    const existing = this.pending.get(fullPath);
    
    // The "base" content to diff against should be the one BEFORE this batch started.
    // If it's already in pending, that 'before' is what we want.
    // If not in pending, it's what's currently in cache.
    const baseContent = existing ? (existing.before ?? "") : (cached?.content ?? "");
    const type = existing ? existing.type : "modified";

    // Update the cache for the NEXT event
    this.cache.set(fullPath, { content: sanitized, hash });

    const diff = createTwoFilesPatch(
      displayPath,
      displayPath,
      baseContent,
      sanitized,
      "before",
      "after",
    );

    const change: FileChange = {
      path: displayPath,
      type: type as any,
      before: baseContent,
      after: sanitized,
      diff: this.simplifyDiff(diff),
      timestamp: Date.now(),
      language: detectLanguage(fullPath),
    };

    this.pending.set(fullPath, change);
    return change;
  }

  private handleDelete(fullPath: string): FileChange | null {
    const existing = this.pending.get(fullPath);
    const cached = this.cache.get(fullPath);
    this.cache.delete(fullPath);
    const displayPath = this.normalizePath(fullPath);

    // If it was added in this batch and then deleted, just drop it from pending
    if (existing?.type === "added") {
      this.pending.delete(fullPath);
      return null;
    }

    const baseContent = existing ? (existing.before ?? "") : (cached?.content ?? "");

    const change: FileChange = {
      path: displayPath,
      type: "deleted",
      before: baseContent,
      timestamp: Date.now(),
    };

    this.pending.set(fullPath, change);
    return change;
  }

  // Call this when idle_start fires
  flushChanges(): FileChange[] {
    const changes = Array.from(this.pending.values());
    this.pending.clear();
    return changes;
  }

  // Format for LLM consumption
  formatForLLM(changes: FileChange[]): string {
    if (changes.length === 0) return "";

    const sections = changes.map((change) => {
      const header = `### ${change.type.toUpperCase()}: ${change.path}${change.language ? ` (${change.language})` : ""}`;

      if (change.type === "added") {
        const content = change.after || "";
        const lines = content.split("\n");
        let formattedContent = "";

        if (lines.length <= 100) {
          formattedContent = content;
        } else {
          // Show first 50 and last 50 lines for large files
          formattedContent = [
            ...lines.slice(0, 50),
            `\n... (${lines.length - 100} lines skipped) ...\n`,
            ...lines.slice(-50),
          ].join("\n");
        }

        return `${header}\n\`\`\`${change.language || "text"}\n${formattedContent}\n\`\`\``;
      }

      if (change.type === "deleted") {
        return `${header}\nFile removed (was ${change.before?.split("\n").length || "?"} lines)`;
      }

      // Modified - show the diff
      return `${header}\n\`\`\`diff\n${change.diff}\n\`\`\``;
    });

    return `## File Changes Summary\n\n${sections.join("\n\n")}`;
  }

  private async readFileSafe(path: string): Promise<string | null> {
    try {
      const stats = await stat(path);
      if (stats.size > this.maxFileSize) {
        logger.debug("DIFF", `File too large, skipping: ${path}`);
        return null;
      }
      return await readFile(path, "utf-8");
    } catch {
      return null;
    }
  }

  private simplifyDiff(fullDiff: string): string {
    // Remove the ---/+++ headers that diff creates, keep just the @@ chunks
    return fullDiff
      .split("\n")
      .slice(4) // Remove first 4 lines (file headers)
      .join("\n")
      .slice(0, 2000); // Limit diff size for LLM context
  }

  private truncate(str: string, lines: number): string {
    const split = str.split("\n");
    if (split.length <= lines) return str;
    return (
      split.slice(0, lines).join("\n") +
      `\n... (${split.length - lines} more lines)`
    );
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get pendingChanges(): FileChange[] {
    return Array.from(this.pending.values());
  }

  get hasPendingChanges(): boolean {
    return this.pending.size > 0;
  }
}
