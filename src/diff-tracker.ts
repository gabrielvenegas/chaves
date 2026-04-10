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

  private cache = new Map<string, string>(); // path -> content
  private pending: FileChange[] = [];
  private readonly maxFileSize = 1024 * 1024; // 1MB limit

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
    this.cache.set(fullPath, sanitized);

    const change: FileChange = {
      path: displayPath,
      type: "added",
      after: sanitized,
      timestamp: Date.now(),
      language: detectLanguage(fullPath),
    };

    this.pending.push(change);
    return change;
  }

  private async handleModify(fullPath: string): Promise<FileChange | null> {
    const oldContent = this.cache.get(fullPath) || "";
    const newContent = await this.readFileSafe(fullPath);

    if (newContent === null) return null;
    const displayPath = this.normalizePath(fullPath);

    if (shield.hasApiKey(newContent)) {
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

    const sanitized = shield.sanitize(newContent);
    if (oldContent === sanitized) return null;

    // Generate unified diff
    const diff = createTwoFilesPatch(
      displayPath,
      displayPath,
      oldContent,
      sanitized,
      "before",
      "after",
    );

    this.cache.set(fullPath, sanitized);

    const change: FileChange = {
      path: displayPath,
      type: "modified",
      before: oldContent,
      after: sanitized,
      diff: this.simplifyDiff(diff),
      timestamp: Date.now(),
      language: detectLanguage(fullPath),
    };

    this.pending.push(change);
    return change;
  }

  private handleDelete(fullPath: string): FileChange {
    const oldContent = this.cache.get(fullPath);
    this.cache.delete(fullPath);
    const displayPath = this.normalizePath(fullPath);

    const change: FileChange = {
      path: displayPath,
      type: "deleted",
      before: oldContent,
      timestamp: Date.now(),
    };

    this.pending.push(change);
    return change;
  }

  // Call this when idle_start fires
  flushChanges(): FileChange[] {
    const changes = [...this.pending];
    this.pending = [];
    return changes;
  }

  // Format for LLM consumption
  formatForLLM(changes: FileChange[]): string {
    if (changes.length === 0) return "";

    const sections = changes.map((change) => {
      const header = `### ${change.type.toUpperCase()}: ${change.path}${change.language ? ` (${change.language})` : ""}`;

      if (change.type === "added") {
        return `${header}\n\`\`\`${change.language || "text"}\n${this.truncate(change.after || "", 100)}\n\`\`\``;
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
    return this.pending.length;
  }

  get pendingChanges(): readonly FileChange[] {
    return this.pending;
  }

  get hasPendingChanges(): boolean {
    return this.pending.length > 0;
  }
}
