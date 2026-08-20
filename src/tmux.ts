import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { logger } from "./logger.js";

const TMUX_BINARY = "tmux";
const TMUX_SESSION_NAME = "chaves";
const DEFAULT_LOGIN_SHELL = "/bin/zsh";
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ENTRY_SCRIPT_PATH = resolve(PACKAGE_ROOT, "src", "index.ts");

// createRequire gives us CJS require.resolve, which walks the node_modules
// tree from this file's location — robust against npm hoisting in global installs.
const moduleRequire = createRequire(import.meta.url);

/**
 * Resolve the tsx CLI entrypoint from this package's dependencies.
 * Uses Node's module resolution so it works whether chaves is run from a
 * local checkout, installed globally (with hoisted deps), or via npx.
 */
function resolveTsxRuntime(): string {
  return moduleRequire.resolve("tsx/cli");
}

export interface TmuxBootstrapContext {
  projectPath: string;
  devCommand: string;
}

export interface TmuxBootstrapResult {
  bootstrapped: boolean;
  managed: boolean;
  tmuxMissing: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCommand(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

function runTmux(
  socketPath: string,
  args: string[],
  {
    inheritStdio = false,
  }: { inheritStdio?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    TMUX_BINARY,
    ["-S", socketPath, ...args],
    {
      encoding: "utf8",
      stdio: inheritStdio ? "inherit" : "pipe",
    },
  );

  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
  };
}

function runTmuxChecked(
  socketPath: string,
  args: string[],
  step: string,
  options?: { inheritStdio?: boolean },
): string {
  const result = runTmux(socketPath, args, options);
  if (result.status !== 0) {
    throw new Error(
      result.stderr || `tmux command failed during ${step}: ${args.join(" ")}`,
    );
  }
  return result.stdout;
}

export function ensureTmuxAvailable(): boolean {
  const result = spawnSync(TMUX_BINARY, ["-V"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

export function buildManagedSocketName(projectPath: string): string {
  return `chaves-${createHash("sha1").update(projectPath).digest("hex").slice(0, 10)}.sock`;
}

export function buildManagedSocketPath(projectPath: string): string {
  const baseDir = resolve("/tmp", "chaves-tmux");
  mkdirSync(baseDir, { recursive: true });
  return resolve(baseDir, buildManagedSocketName(projectPath));
}

export function isInsideManagedTmuxSession(): boolean {
  return process.env.CHAVES_TMUX_MANAGED === "1";
}

function buildBaseRuntimeArgv(): string[] {
  if (process.versions.bun) {
    return [process.execPath, ENTRY_SCRIPT_PATH];
  }

  // Under Node, run the entry via tsx so TypeScript is handled at runtime.
  // Resolve tsx from chaves's own package deps (not the target project's).
  return [process.execPath, resolveTsxRuntime(), ENTRY_SCRIPT_PATH];
}

function buildEnvPrefix(env: Record<string, string>): string {
  const pairs = Object.entries(env).map(([key, value]) =>
    `${key}=${shellQuote(value)}`
  );
  return `env ${pairs.join(" ")}`;
}

export function buildChatPaneCommand({
  projectPath,
  socketPath,
}: {
  projectPath: string;
  socketPath: string;
}): string {
  const envPrefix = buildEnvPrefix({
    CHAVES_TMUX_MANAGED: "1",
    CHAVES_TMUX_SOCKET: socketPath,
    CHAVES_TMUX_SESSION: TMUX_SESSION_NAME,
  });
  // Pass projectPath as a positional arg; no cd needed (main() reads positionalArgs[0]).
  const runtimeCommand = buildCommand([...buildBaseRuntimeArgv(), projectPath]);
  return `${envPrefix} ${runtimeCommand}`;
}

export function buildRelayCommand({
  projectPath,
}: {
  projectPath: string;
}): string {
  const envPrefix = buildEnvPrefix({
    CHAVES_TMUX_MANAGED: "1",
  });
  const runtimeCommand = buildCommand([
    ...buildBaseRuntimeArgv(),
    "--tmux-relay",
    projectPath,
  ]);
  return `${envPrefix} ${runtimeCommand}`;
}

export function buildDevPaneCommand({
  projectPath,
  devCommand,
}: {
  projectPath: string;
  devCommand: string;
}): string {
  const shellPath = process.env.SHELL?.trim() || DEFAULT_LOGIN_SHELL;
  const exitMessage = "[chaves] dev command exited (code: %s)\\n";

  return [
    `cd ${shellQuote(projectPath)}`,
    devCommand,
    "status=$?",
    `printf ${shellQuote(exitMessage)} \"$status\"`,
    `exec ${shellQuote(shellPath)} -l`,
  ].join("; ");
}

function hasManagedSession(socketPath: string): boolean {
  const result = runTmux(socketPath, ["has-session", "-t", TMUX_SESSION_NAME]);
  return result.status === 0;
}

function resetManagedSession(socketPath: string): void {
  if (hasManagedSession(socketPath)) {
    runTmuxChecked(
      socketPath,
      ["kill-session", "-t", TMUX_SESSION_NAME],
      "resetting existing managed session",
    );
  }

  rmSync(socketPath, { force: true });
}

function getPaneId(socketPath: string, args: string[], step: string): string {
  const paneId = runTmuxChecked(socketPath, args, step);
  if (!paneId) {
    throw new Error(`tmux did not return a pane id during ${step}`);
  }
  return paneId;
}

export function attachManagedSession(socketPath: string): void {
  logger.info("APP", "Attaching to tmux-managed split");
  const result = runTmux(socketPath, ["attach-session", "-t", TMUX_SESSION_NAME], {
    inheritStdio: true,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "Failed to attach tmux session.");
  }
}

export function enablePaneToggleBinding(socketPath: string): void {
  runTmuxChecked(
    socketPath,
    ["bind-key", "-n", "C-l", "last-pane"],
    "binding Ctrl+L",
  );
}

export function enablePaneOutputPipe({
  socketPath,
  paneId,
  relayCommand,
}: {
  socketPath: string;
  paneId: string;
  relayCommand: string;
}): void {
  runTmuxChecked(
    socketPath,
    ["pipe-pane", "-O", "-t", paneId, relayCommand],
    "enabling pane output pipe",
  );
}

export function startManagedSession({
  projectPath,
  devCommand,
}: TmuxBootstrapContext): { socketName: string } {
  const socketPath = buildManagedSocketPath(projectPath);
  resetManagedSession(socketPath);

  const chatPaneCommand = buildChatPaneCommand({ projectPath, socketPath });
  const devPaneCommand = buildDevPaneCommand({ projectPath, devCommand });
  const relayCommand = buildRelayCommand({ projectPath });

  const chatPaneId = getPaneId(
    socketPath,
    [
      "new-session",
      "-d",
      "-s",
      TMUX_SESSION_NAME,
      "-P",
      "-F",
      "#{pane_id}",
      chatPaneCommand,
    ],
    "creating chat pane",
  );

  const devPaneId = getPaneId(
    socketPath,
    [
      "split-window",
      "-h",
      "-t",
      chatPaneId,
      "-P",
      "-F",
      "#{pane_id}",
      devPaneCommand,
    ],
    "creating dev pane",
  );

  runTmuxChecked(socketPath, ["set-option", "-g", "status", "off"], "disabling tmux status bar");
  runTmuxChecked(socketPath, ["select-layout", "-t", TMUX_SESSION_NAME, "even-horizontal"], "setting layout");
  enablePaneToggleBinding(socketPath);
  enablePaneOutputPipe({ socketPath, paneId: devPaneId, relayCommand });
  runTmuxChecked(socketPath, ["select-pane", "-t", chatPaneId], "focusing chat pane");

  return { socketName: socketPath };
}

export function maybeBootstrapTmuxSession(
  context: TmuxBootstrapContext,
): TmuxBootstrapResult {
  if (!context.devCommand.trim()) {
    return { bootstrapped: false, managed: false, tmuxMissing: false };
  }

  if (isInsideManagedTmuxSession()) {
    return { bootstrapped: false, managed: true, tmuxMissing: false };
  }

  if (!ensureTmuxAvailable()) {
    return { bootstrapped: false, managed: false, tmuxMissing: true };
  }

  const { socketName } = startManagedSession(context);
  attachManagedSession(socketName);
  return { bootstrapped: true, managed: false, tmuxMissing: false };
}

export function killManagedSession(): void {
  const socketName = process.env.CHAVES_TMUX_SOCKET;
  const sessionName = process.env.CHAVES_TMUX_SESSION || TMUX_SESSION_NAME;

  if (process.env.CHAVES_TMUX_MANAGED !== "1" || !socketName) {
    return;
  }

  runTmux(socketName, ["kill-session", "-t", sessionName]);
}
