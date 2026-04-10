import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import { detectLanguage, isBinaryPath, isIgnoredPath } from "./file-rules.js";
import { logger } from "./logger.js";
import { shield } from "./shield.js";
import { Store } from "./store.js";

export interface IndexerOptions {
  maxFileSizeBytes: number;
  batchSize?: number;
}

export interface IndexerResult {
  indexedFiles: number;
  blockedFiles: number;
  skippedFiles: number;
}

export class Indexer {
  private readonly batchSize: number;

  constructor(
    private readonly projectPath: string,
    private readonly store: Store,
    private readonly options: IndexerOptions,
  ) {
    this.batchSize = Math.max(1, options.batchSize ?? 25);
  }

  async indexProject(): Promise<IndexerResult> {
    const filePaths = await this.collectFiles(this.projectPath);
    let indexedFiles = 0;
    let blockedFiles = 0;
    let skippedFiles = 0;

    logger.debug("INDEXER", `Collected ${filePaths.length} files to index`);

    for (let start = 0; start < filePaths.length; start += this.batchSize) {
      const batch = filePaths.slice(start, start + this.batchSize);

      for (const absolutePath of batch) {
        const relativePath = this.toRelativePath(absolutePath);
        if (!relativePath || shield.isSensitiveFile(relativePath)) {
          skippedFiles++;
          continue;
        }

        if (isBinaryPath(relativePath)) {
          skippedFiles++;
          continue;
        }

        let fileStats;
        try {
          fileStats = await stat(absolutePath);
        } catch {
          skippedFiles++;
          continue;
        }

        if (fileStats.size > this.options.maxFileSizeBytes) {
          skippedFiles++;
          continue;
        }

        let content: string;
        try {
          content = await readFile(absolutePath, "utf-8");
        } catch {
          skippedFiles++;
          continue;
        }

        const blocked = shield.hasApiKey(content);
        if (blocked) blockedFiles++;
        if (!blocked) indexedFiles++;

        this.store.upsertFile({
          path: relativePath,
          content,
          blocked,
          language: detectLanguage(relativePath),
          sizeBytes: fileStats.size,
        });
      }

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    logger.debug("INDEXER", "Project index complete", {
      indexedFiles,
      blockedFiles,
      skippedFiles,
    });

    return { indexedFiles, blockedFiles, skippedFiles };
  }

  private async collectFiles(rootDir: string): Promise<string[]> {
    const stack = [rootDir];
    const files: string[] = [];

    while (stack.length > 0) {
      const currentDir = stack.pop();
      if (!currentDir) continue;

      let entries;
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relativePath = this.toRelativePath(fullPath);
        if (!relativePath) continue;
        if (isIgnoredPath(relativePath)) continue;

        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  private toRelativePath(fullPath: string): string {
    return relative(this.projectPath, fullPath).replace(/\\/g, "/");
  }
}
