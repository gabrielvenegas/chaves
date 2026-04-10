import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { stripVTControlCharacters } from "util";
import { logger } from "./logger.js";

export interface TerminalEvent {
  stream: "stdout" | "stderr";
  data: string;
  timestamp: string;
}

export class TerminalCapture extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly command: string;
  private readonly projectPath: string;

  constructor(command: string, projectPath: string) {
    super();
    this.command = command;
    this.projectPath = projectPath;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;

    logger.info("APP", `TerminalCapture: spawning '${this.command}'`);

    this.child = spawn(this.command, [], {
      shell: true,
      cwd: this.projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });

    const stdoutBuf = this.makeLineBuffer("stdout");
    const stderrBuf = this.makeLineBuffer("stderr");

    this.child.stdout?.on("data", (chunk: Buffer) => stdoutBuf(chunk.toString("utf8")));
    this.child.stderr?.on("data", (chunk: Buffer) => stderrBuf(chunk.toString("utf8")));

    this.child.on("error", (err) => {
      logger.error("APP", "TerminalCapture child error", err);
      this.emitLine("stderr", `[chaves] process error: ${err.message}`);
    });

    this.child.on("exit", (code, signal) => {
      const msg = signal
        ? `[chaves] process exited (signal: ${signal})`
        : `[chaves] process exited (code: ${code ?? "?"})`;
      logger.info("APP", `TerminalCapture: ${msg}`);
      this.emitLine("stderr", msg);
      this.child = null;
    });
  }

  stop(): void {
    if (!this.child) return;
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.kill("SIGTERM");
    this.child = null;
  }

  private makeLineBuffer(stream: "stdout" | "stderr"): (chunk: string) => void {
    let partial = "";
    let lastLine = "";
    let repeatCount = 0;

    return (chunk: string) => {
      const clean = this.sanitizeChunk(chunk);
      const combined = partial + clean;
      const lines = combined.split("\n");
      partial = lines.pop() ?? "";

      for (const line of lines) {
        // Simulate terminal carriage-return overwrite: keep only the last segment after \r
        const crSegments = line.split("\r");
        const trimmed = (crSegments[crSegments.length - 1] ?? line).trimEnd();
        if (!trimmed) continue;

        if (trimmed === lastLine) {
          repeatCount++;
          if (repeatCount >= 3) continue; // suppress after 3 repeats
        } else {
          if (repeatCount >= 3) {
            this.emitLine(stream, `[repeated ${repeatCount - 2} more times]`);
          }
          lastLine = trimmed;
          repeatCount = 1;
        }

        this.emitLine(stream, trimmed);
      }
    };
  }

  private sanitizeChunk(chunk: string): string {
    return stripVTControlCharacters(chunk)
      .replace(/\r\n/g, "\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    // \r (carriage return without \n) is left for makeLineBuffer to handle
    // so progress spinners show only their final state, not each intermediate frame
  }

  private emitLine(stream: "stdout" | "stderr", data: string): void {
    const event: TerminalEvent = {
      stream,
      data,
      timestamp: new Date().toISOString(),
    };
    this.emit("terminal_event", event);
  }
}
