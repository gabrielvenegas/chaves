import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { logger } from "./logger.js";

const TMUX_BINARY = "tmux";
const TMUX_SESSION_NAME = "chaves";
const DEFAULT_LOGIN_SHELL = "/bin/zsh";

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
  socketName: string,
  args: string[],
  {
    inheritStdio = false,
  }: { inheritStdio?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    TMUX_BINARY,
    ["-L", socketName, ...args],
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
  socketName: string,
  args: string[],
  step: string,
  options?: { inheritStdio?: boolean },
): string {
  const result = runTmux(socketName, args, options);
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
  return `chaves-${createHash("sha1").update(projectPath).digest("hex").slice(0, 10)}`;
}

export function isInsideManagedTmuxSession(): boolean {
  return process.env.CHAVES_TMUX_MANAGED === "1";
}

function buildBaseRuntimeArgv(): string[] {
  return [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
}

function getEntryScriptArg(): string {
  const scriptArg = process.argv[1];
  if (!scriptArg) {
    throw new Error("Unable to determine the CHAVES entry script for tmux mode.");
  }
  return scriptArg;
}

function buildEnvPrefix(env: Record<string, string>): string {
  const pairs = Object.entries(env).map(([key, value]) =>
    `${key}=${shellQuote(value)}`
  );
  return `env ${pairs.join(" ")}`;
}

export function buildChatPaneCommand({
  projectPath,
  socketName,
}: {
  projectPath: string;
  socketName: string;
}): string {
  const envPrefix = buildEnvPrefix({
    CHAVES_TMUX_MANAGED: "1",
    CHAVES_TMUX_SOCKET: socketName,
    CHAVES_TMUX_SESSION: TMUX_SESSION_NAME,
  });
  const runtimeCommand = buildCommand(buildBaseRuntimeArgv());
  return `cd ${shellQuote(projectPath)} && ${envPrefix} ${runtimeCommand}`;
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
    process.execPath,
    ...process.execArgv,
    getEntryScriptArg(),
    "--tmux-relay",
    projectPath,
  ]);
  return `cd ${shellQuote(projectPath)} && ${envPrefix} ${runtimeCommand}`;
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

function hasManagedSession(socketName: string): boolean {
  const result = runTmux(socketName, ["has-session", "-t", TMUX_SESSION_NAME]);
  return result.status === 0;
}

function getPaneId(socketName: string, args: string[], step: string): string {
  const paneId = runTmuxChecked(socketName, args, step);
  if (!paneId) {
    throw new Error(`tmux did not return a pane id during ${step}`);
  }
  return paneId;
}

export function attachManagedSession(socketName: string): void {
  logger.info("APP", "Attaching to tmux-managed split");
  const result = runTmux(socketName, ["attach-session", "-t", TMUX_SESSION_NAME], {
    inheritStdio: true,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "Failed to attach tmux session.");
  }
}

export function enablePaneToggleBinding(socketName: string): void {
  runTmuxChecked(
    socketName,
    ["bind-key", "-n", "C-l", "last-pane"],
    "binding Ctrl+L",
  );
}

export function enablePaneOutputPipe({
  socketName,
  paneId,
  relayCommand,
}: {
  socketName: string;
  paneId: string;
  relayCommand: string;
}): void {
  runTmuxChecked(
    socketName,
    ["pipe-pane", "-O", "-t", paneId, relayCommand],
    "enabling pane output pipe",
  );
}

export function startManagedSession({
  projectPath,
  devCommand,
}: TmuxBootstrapContext): { socketName: string } {
  const socketName = buildManagedSocketName(projectPath);

  if (hasManagedSession(socketName)) {
    return { socketName };
  }

  const chatPaneCommand = buildChatPaneCommand({ projectPath, socketName });
  const devPaneCommand = buildDevPaneCommand({ projectPath, devCommand });
  const relayCommand = buildRelayCommand({ projectPath });

  const chatPaneId = getPaneId(
    socketName,
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
    socketName,
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

  runTmuxChecked(socketName, ["set-option", "-g", "status", "off"], "disabling tmux status bar");
  runTmuxChecked(socketName, ["select-layout", "-t", TMUX_SESSION_NAME, "even-horizontal"], "setting layout");
  enablePaneToggleBinding(socketName);
  enablePaneOutputPipe({ socketName, paneId: devPaneId, relayCommand });
  runTmuxChecked(socketName, ["select-pane", "-t", chatPaneId], "focusing chat pane");

  return { socketName };
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
