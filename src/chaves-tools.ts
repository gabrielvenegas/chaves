import { tool } from "ai";
import { z } from "zod";
import type { Store } from "./store.js";

const DEFAULT_FILE_MAX_CHARS = 12_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} chars]`;
}

export function createChavesTools({ store }: { store: Store }) {
  return {
    recent_events: tool({
      description:
        "Get the most recent watched file events from the project database.",
      parameters: z.object({
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: async ({ limit }) => {
        const safeLimit = clamp(limit, 1, 100);
        const events = store
          .getRecentEvents(safeLimit)
          .map((event) => ({
            id: event.id ?? null,
            timestamp: event.timestamp,
            event_type: event.event_type,
            file_path: event.file_path,
            details: event.details ?? null,
          }));
        return { events };
      },
    }),

    recent_diffs: tool({
      description:
        "Get recent saved diff snapshots. Use includeChanges=true only when needed.",
      parameters: z.object({
        limit: z.number().int().min(1).max(25).default(5),
        includeChanges: z.boolean().default(false),
      }),
      execute: async ({ limit, includeChanges }) => {
        const safeLimit = clamp(limit, 1, 25);
        const snapshots = store
          .getRecentDiffSnapshots(safeLimit)
          .map((snapshot) => ({
            id: snapshot.id,
            timestamp: snapshot.timestamp,
            change_count: snapshot.change_count,
            prompt_preview: truncate(snapshot.prompt, 500),
            changes_json: includeChanges
              ? truncate(snapshot.changes_json, 8_000)
              : undefined,
          }));

        return { snapshots };
      },
    }),

    get_diff: tool({
      description: "Get one diff snapshot by ID.",
      parameters: z.object({
        id: z.number().int().min(1),
      }),
      execute: async ({ id }) => {
        const snapshot = store.getDiffSnapshotById(id);
        if (!snapshot) return { error: "Diff snapshot not found." };

        return {
          id: snapshot.id,
          timestamp: snapshot.timestamp,
          change_count: snapshot.change_count,
          prompt: truncate(snapshot.prompt, 5_000),
          changes_json: truncate(snapshot.changes_json, 10_000),
        };
      },
    }),

    get_file: tool({
      description:
        "Get file contents from indexed project files. Paths are project-relative.",
      parameters: z.object({
        path: z.string().min(1),
        maxChars: z.number().int().min(200).max(50_000).default(DEFAULT_FILE_MAX_CHARS),
      }),
      execute: async ({ path, maxChars }) => {
        try {
          const file = store.getFile(path);
          if (!file) return { error: "File not found in index." };
          if (file.blocked === 1) {
            return {
              path: file.path,
              language: file.language,
              blocked: true,
              content: "",
            };
          }

          return {
            path: file.path,
            language: file.language,
            blocked: false,
            size_bytes: file.size_bytes,
            content: truncate(file.content, clamp(maxChars, 200, 50_000)),
          };
        } catch (error) {
          return {
            error:
              error instanceof Error ? error.message : "Invalid path argument.",
          };
        }
      },
    }),

    search_code: tool({
      description:
        "Search indexed code/content in project files by natural language query or identifiers.",
      parameters: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
        pathPrefix: z.string().min(1).optional(),
      }),
      execute: async ({ query, limit, pathPrefix }) => {
        try {
          const safeLimit = clamp(limit, 1, 20);
          const results = store.searchFiles({
            query,
            limit: safeLimit,
            pathPrefix,
          });

          return {
            results: results.map((result) => ({
              path: result.path,
              language: result.language,
              blocked: result.blocked,
              snippet: truncate(result.snippet, 1_000),
            })),
          };
        } catch (error) {
          return {
            error:
              error instanceof Error
                ? error.message
                : "Could not run code search.",
          };
        }
      },
    }),

    terminal_output: tool({
      description:
        "Get recent terminal output (stdout/stderr) captured from the user's running dev process. Use this to see runtime errors, logs, and warnings from the app.",
      parameters: z.object({
        limit: z.number().int().min(1).max(200).default(50),
        stream: z.enum(["stdout", "stderr", "all"]).default("all"),
      }),
      execute: async ({ limit, stream }) => {
        const safeLimit = clamp(limit, 1, 200);
        const events = store
          .getRecentTerminalEvents(safeLimit)
          .filter((e) => stream === "all" || e.stream === stream)
          .map((e) => ({
            id: e.id,
            timestamp: e.timestamp,
            stream: e.stream,
            data: truncate(e.data, 2_000),
          }));
        return { events };
      },
    }),

    list_files: tool({
      description:
        "List indexed project files, optionally filtered by a project-relative prefix.",
      parameters: z.object({
        limit: z.number().int().min(1).max(500).default(100),
        pathPrefix: z.string().min(1).optional(),
      }),
      execute: async ({ limit, pathPrefix }) => {
        try {
          const safeLimit = clamp(limit, 1, 500);
          const files = store.listFiles({ limit: safeLimit, pathPrefix });
          return {
            files: files.map((file) => ({
              path: file.path,
              language: file.language,
              blocked: file.blocked,
              size_bytes: file.size_bytes,
              timestamp: file.timestamp,
            })),
          };
        } catch (error) {
          return {
            error:
              error instanceof Error
                ? error.message
                : "Could not list indexed files.",
          };
        }
      },
    }),
  };
}
