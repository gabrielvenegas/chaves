import { createHash, randomUUID } from "crypto";
import * as os from "os";
import { createInterface } from "readline";
import { stripVTControlCharacters } from "util";
import {
  buildFallbackContext,
  buildUserIntentContext,
  handleSlashCommand,
} from "./chatCommands.js";
import { createChavesTools } from "./chaves-tools.js";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "./file-rules.js";
import { Indexer } from "./indexer.js";
import { logger } from "./logger.js";
import { runOnboardingIfNeeded } from "./onboarding.js";
import { runSetup } from "./setup.js";
import {
  Summarizer,
  type MessageFrequencyLevel,
  type Personality,
  type ProactiveInsight,
  type SessionGoalContext,
} from "./summarizer.js";
import {
  Store,
  type ActivityEvent,
  type MessageRole,
  type StoredMessage,
  type TerminalEventRecord,
} from "./store.js";
import {
  isInsideManagedTmuxSession,
  killManagedSession,
  maybeBootstrapTmuxSession,
} from "./tmux.js";
import { UI } from "./ui.js";
import { Watcher } from "./watcher.js";

const INDEX_ON_START = parseEnvBool("CHAVES_INDEX_ON_START", true);
const INDEX_MAX_FILE_SIZE = parseEnvInt(
  "CHAVES_INDEX_MAX_FILE_SIZE",
  DEFAULT_MAX_FILE_SIZE_BYTES,
);
const CHAT_CONTEXT_MESSAGES = parseEnvInt("CHAVES_CHAT_CONTEXT_MESSAGES", 20);
const CHAT_SUMMARY_THRESHOLD = parseEnvInt("CHAVES_CHAT_SUMMARY_THRESHOLD", 40);
const TERMINAL_BUFFER_LIMIT = 200;
const TERMINAL_INCIDENT_EXCERPT_LINES = 80;
const TERMINAL_FINGERPRINT_LINES = 20;
const TERMINAL_POLL_BATCH_SIZE = 200;
const DEBUG_INCIDENT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEBUG_ERROR_BURST_DEBOUNCE_MS = 1500;
const PROACTIVE_DEBUG_COOLDOWN_MS = 15_000;
const FATAL_TERMINAL_PATTERNS = [
  /\b(?:error|exception|panic|traceback)\b/i,
  /\b(?:module not found|cannot find module|failed to compile|build failed)\b/i,
  /\b(?:uncaught|syntaxerror|typeerror|referenceerror)\b/i,
];

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isCountableEventType(type: ActivityEvent["event_type"]): boolean {
  return type !== "idle_start" && type !== "idle_end";
}

function isCountableEvent(event: ActivityEvent): boolean {
  return isCountableEventType(event.event_type);
}

function getUniqueFileCount(events: ActivityEvent[]): number {
  return new Set(events.map((event) => event.file_path).filter(Boolean)).size;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

function shortenModelName(model: string): string {
  return model.split("/").at(-1) ?? model;
}

function getCpuCoreCount(): number {
  if (typeof os.availableParallelism === "function") {
    return Math.max(1, os.availableParallelism());
  }

  return Math.max(1, os.cpus().length);
}

function mapToChatHistory(messages: StoredMessage[]): Array<{
  role: MessageRole;
  content: string;
}> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

interface SessionGoalState extends SessionGoalContext {
  updatedAt: number;
}

interface PendingDebugIncident {
  incidentId: number;
  fingerprint: string;
  trigger: string;
  exitCode: number | null;
  signal: string | null;
  logExcerpt: string;
  candidateFiles: string[];
  recentEvents: ActivityEvent[];
  eventRangeEnd: number | null;
  diffSnapshotId: number | null;
  diffSummary?: string;
}

function normalizeRelatedFiles(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))].slice(0, 3);
}

function buildProactiveMessage(insight: ProactiveInsight): string {
  const sections = [
    `**Current Focus**\n${insight.goal} → ${insight.focus}`,
    `**Suggestion**\n${insight.suggestionText}`,
  ];

  const relatedFiles = normalizeRelatedFiles(insight.relatedFiles);
  if (relatedFiles.length > 0) {
    sections.push(`**Related Files**\n${relatedFiles.join(", ")}`);
  }

  return sections.join("\n\n");
}

function buildDebugIncidentMessage(input: {
  headline: string;
  summary: string;
  relatedFiles: string[];
}): string {
  const sections = [
    `**Debug Incident**\n${input.headline}`,
    input.summary.trim(),
  ];

  const relatedFiles = normalizeRelatedFiles(input.relatedFiles);
  if (relatedFiles.length > 0) {
    sections.push(`**Related Files**\n${relatedFiles.join(", ")}`);
  }

  return sections.join("\n\n");
}

function normalizeTerminalFingerprintLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/\b\d+\b/g, "#")
    .replace(/0x[0-9a-f]+/gi, "0x#")
    .replace(/\s+/g, " ")
    .trim();
}

function isFatalTerminalLine(line: string): boolean {
  if (/\bwarning\b/i.test(line)) return false;
  return FATAL_TERMINAL_PATTERNS.some((pattern) => pattern.test(line));
}

function parseManagedFailureTrigger(line: string): {
  trigger: string;
  exitCode: number | null;
  signal: string | null;
} | null {
  const exitMatch = line.match(/^\[chaves\] dev command exited \(code: (-?\d+)\)$/);
  if (exitMatch) {
    const exitCode = Number.parseInt(exitMatch[1] ?? "", 10);
    if (Number.isFinite(exitCode) && exitCode !== 0) {
      return {
        trigger: `dev command exited with code ${exitCode}`,
        exitCode,
        signal: null,
      };
    }
    return null;
  }

  const signalMatch = line.match(/^\[chaves\] process exited \(signal: ([^)]+)\)$/);
  if (signalMatch) {
    return {
      trigger: `dev command exited with signal ${signalMatch[1]}`,
      exitCode: null,
      signal: signalMatch[1] ?? null,
    };
  }

  return null;
}

function isBuildFailureLine(line: string): boolean {
  return (
    /\[error\]/i.test(line) ||
    /\bbuild failed\b/i.test(line) ||
    /\bfailed with \d+ error\b/i.test(line) ||
    /\bexpected .+ but found\b/i.test(line) ||
    /^\s*[A-Za-z0-9_./-]+\:\d+\:\d+\:?/.test(line)
  );
}

function extractProjectPathsFromText(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|md)/g) ?? [];
  return [...new Set(matches
    .map((value) => value.replace(/^[./]+/, "").trim())
    .filter((value) => value.length > 0 && !value.startsWith("/"))
  )].slice(0, 5);
}

function extractSearchQueriesFromLog(logExcerpt: string): string[] {
  const queries: string[] = [];
  const pathMatches = extractProjectPathsFromText(logExcerpt);
  for (const path of pathMatches) {
    queries.push(path.split("/").at(-1) ?? path);
  }

  const codeMatches = logExcerpt.match(/\b[A-Z]{2,}\d{2,}\b/g) ?? [];
  for (const code of codeMatches) {
    queries.push(code);
  }

  const quotedMatches = [
    ...(logExcerpt.match(/"([^"]{3,80})"/g) ?? []),
    ...(logExcerpt.match(/'([^']{3,80})'/g) ?? []),
  ];
  for (const match of quotedMatches) {
    queries.push(match.slice(1, -1));
  }

  const identifierMatches = logExcerpt.match(/\b[A-Za-z_][A-Za-z0-9_]{3,40}\b/g) ?? [];
  for (const identifier of identifierMatches) {
    if (/^(error|failed|cannot|module|trace|stack|build|command)$/i.test(identifier)) {
      continue;
    }
    queries.push(identifier);
  }

  return [...new Set(queries.map((value) => value.trim()).filter((value) => value.length >= 3))].slice(0, 3);
}

async function runTmuxRelayMode(projectPath: string): Promise<void> {
  const store = new Store(projectPath);
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  let lastLine = "";
  let repeatCount = 0;

  const flushRepeatCount = () => {
    if (repeatCount >= 3) {
      store.addTerminalEvent({
        stream: "stdout",
        data: `[repeated ${repeatCount - 2} more times]`,
      });
    }
  };

  const sanitizeLine = (line: string): string => {
    const stripped = stripVTControlCharacters(line)
      .replace(/\r\n/g, "\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    const segments = stripped.split("\r");
    return (segments[segments.length - 1] ?? stripped).trimEnd();
  };

  for await (const rawLine of rl) {
    const line = sanitizeLine(rawLine);
    if (!line) continue;

    if (line === lastLine) {
      repeatCount++;
      if (repeatCount >= 3) continue;
    } else {
      flushRepeatCount();
      lastLine = line;
      repeatCount = 1;
    }

    store.addTerminalEvent({ stream: "stdout", data: line });
  }

  flushRepeatCount();
}

async function main() {
  const args = process.argv.slice(2);
  const relayFlagIndex = args.indexOf("--tmux-relay");

  if (relayFlagIndex !== -1) {
    const relayProjectPath = args[relayFlagIndex + 1];
    if (!relayProjectPath) {
      throw new Error("Missing project path for --tmux-relay");
    }
    await runTmuxRelayMode(relayProjectPath);
    return;
  }

  const setupFlagIndex = ["--setup", "setup"]
    .map((flag) => args.indexOf(flag))
    .find((index) => index !== -1);

  if (setupFlagIndex !== undefined) {
    const maybePath = args[setupFlagIndex + 1];
    const setupPath =
      maybePath && !maybePath.startsWith("-") ? maybePath : process.cwd();
    await runSetup(setupPath);
    return;
  }

  const chatOnlyMode = args.includes("--chat-only") || args.includes("--standalone");
  const forceOnboarding = args.includes("--onboarding") || args.includes("onboarding");
  const positionalArgs = args.filter(
    (arg) =>
      arg !== "--onboarding" &&
      arg !== "onboarding" &&
      arg !== "--chat-only" &&
      arg !== "--standalone" &&
      !arg.startsWith("-"),
  );
  const projectPath = positionalArgs[0] ?? process.cwd();
  const debugMode = process.env.CHAVES_DEBUG === "true";
  const sessionId = randomUUID();

  logger.setDebugMode(debugMode);
  logger.info("CONFIG", debugMode ? "Debug mode enabled" : "Debug mode disabled");
  logger.appStart(projectPath);

  const store = new Store(projectPath);

  const onboardingResult = await runOnboardingIfNeeded({
    projectPath,
    store,
    force: forceOnboarding,
  });
  if (onboardingResult === "aborted") {
    process.exit(0);
  }

  const devCommand = store.getConfig("dev_command")?.trim() ?? "";
  const tmuxBootstrap = chatOnlyMode
    ? { bootstrapped: false, managed: false, tmuxMissing: false }
    : maybeBootstrapTmuxSession({
        projectPath,
        devCommand,
      });
  if (tmuxBootstrap.bootstrapped) {
    return;
  }

  const frequencyLevelStr = store.getConfigEnum(
    "message_frequency_level",
    ["1", "2", "3"] as const,
    "2",
  );
  const frequencyLevel = Number.parseInt(
    frequencyLevelStr,
    10,
  ) as MessageFrequencyLevel;
  const personality = store.getConfigEnum(
    "personality",
    ["technical", "collaborative", "creative"] as const,
    "collaborative",
  ) as Personality;

  const inferenceMode = store.getConfigEnum(
    "inference_mode",
    ["managed", "byok"] as const,
    "managed",
  );
  const storedKey = store.getConfig("openrouter_api_key")?.trim() ?? "";
  const apiKey =
    inferenceMode === "byok" && storedKey.length > 0
      ? storedKey
      : process.env.OPENROUTER_API_KEY;

  const baseSummaryThreshold =
    frequencyLevel === 1 ? 20 : frequencyLevel === 3 ? 5 : 10;
  const baseMinUniqueFiles =
    frequencyLevel === 1 ? 2 : frequencyLevel === 3 ? 1 : 1;
  const baseMinCountableEvents =
    frequencyLevel === 1 ? 10 : frequencyLevel === 3 ? 4 : 7;

  const SUMMARY_THRESHOLD = parseEnvInt(
    "CHAVES_SUMMARY_THRESHOLD",
    baseSummaryThreshold,
  );
  const SUMMARY_MIN_UNIQUE_FILES = parseEnvInt(
    "CHAVES_SUMMARY_MIN_FILES",
    baseMinUniqueFiles,
  );
  const SUMMARY_MIN_COUNTABLE_EVENTS = parseEnvInt(
    "CHAVES_SUMMARY_MIN_EVENTS",
    baseMinCountableEvents,
  );

  const summarizer = new Summarizer({
    model: store.getModel(),
    language: store.getLanguage(),
    apiKey,
    frequencyLevel,
    personality,
    thinkingEffort: store.getThinkingEffort(),
  });
  const watcher = new Watcher(projectPath);
  const ui = new UI({
    showPaneToggleHint: tmuxBootstrap.managed,
    theme: store.getTheme(),
  });
  ui.onThemeChange((newTheme) => {
    store.setTheme(newTheme);
  });
  const tools = createChavesTools({ store });
  const indexer = new Indexer(projectPath, store, {
    maxFileSizeBytes: INDEX_MAX_FILE_SIZE,
    batchSize: 25,
    onProgress(indexed, total) {
      ui.setStatus(`Indexing... ${indexed}/${total}`);
    },
  });

  async function performIndexing(forceReindex = false) {
    const existingCount = store.getIndexedFileCount();

    if (existingCount > 0 && !forceReindex) {
      ui.showInfo(`Using ${existingCount} indexed files (CHAVES_FORCE_REINDEX=true to rebuild)`);
      return;
    }

    ui.setWatching(false);
    ui.setStatus("Indexing...");
    ui.showInfo(forceReindex ? "Re-indexing codebase..." : "Indexing codebase...");
    try {
      const result = await indexer.indexProject();
      ui.showSuccess(
        `Indexed ${result.indexedFiles} files (${result.blockedFiles} blocked, ${result.skippedFiles} skipped)`,
      );
    } catch (error) {
      logger.error("APP", "Codebase indexing failed", error);
      ui.showError("Codebase indexing failed", error as Error);
    } finally {
      ui.setStatus("Watching...");
      ui.setWatching(true);
      ui.focusInput();
    }
  }

  ui.onRefresh(() => {
    void performIndexing(true);
  });

  ui.onFileSearch(async (query) => {
    const results = store.listFiles({ 
      pathPrefix: query,
      limit: 10 
    });
    return results.map(f => f.path);
  });

  let eventsSinceLastSummary = 0;
  let lastSummarizedEventId = store.getLastSummary()?.event_range_end ?? 0;
  let isSummarizing = false;
  let isSummarizingChat = false;
  let lastEventSummaryPromptHash: string | null = null;
  let lastSummary = store.getLastSummary();
  let lastChatSummary = store.getLastChatSummary();
  let lastChatSummaryEndMessageId = lastChatSummary?.message_range_end ?? 0;
  let sessionGoalState: SessionGoalState | null = null;
  let lastCpuUsage = process.cpuUsage();
  let lastCpuSampleAt = process.hrtime.bigint();
  let latestRuntimeStats = {
    cpuPercent: 0,
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
  };
  let lastTerminalEventId = store.getRecentTerminalEvents(1).at(0)?.id ?? 0;
  let terminalLineBuffer: string[] = [];
  let sawFatalTerminalOutputSinceLastExit = false;
  let isDiagnosingDebugIncident = false;
  let queuedDebugIncident: PendingDebugIncident | null = null;
  let lastDebugIncidentFingerprint: string | null = null;
  let lastDebugIncidentAt = 0;
  let lastDebugIncidentDiffSnapshotId: number | null = null;
  let lastDebugSignalAt = 0;
  let pendingFatalBurst = false;
  let fatalBurstStartIndex = 0;
  let fatalBurstTimer: NodeJS.Timeout | null = null;

  function refreshSummarizerConfig() {
    summarizer.setModel(store.getModel());
    summarizer.setLanguage(store.getLanguage());
    summarizer.setFrequencyLevel(
      Number.parseInt(
        store.getConfigEnum("message_frequency_level", ["1", "2", "3"] as const, "2"),
        10,
      ) as MessageFrequencyLevel,
    );
    summarizer.setPersonality(
      store.getConfigEnum(
        "personality",
        ["technical", "collaborative", "creative"] as const,
        "collaborative",
      ) as Personality,
    );
    summarizer.setThinkingEffort(store.getThinkingEffort());
  }

  function refreshUiPreferences() {
    ui.setTheme(store.getTheme());
  }

  function sampleRuntimeStats() {
    const memory = process.memoryUsage();
    const now = process.hrtime.bigint();
    const cpuDelta = process.cpuUsage(lastCpuUsage);
    const elapsedMicros = Number(now - lastCpuSampleAt) / 1000;
    const usageMicros = cpuDelta.user + cpuDelta.system;
    const cpuPercent =
      elapsedMicros > 0
        ? (usageMicros / (elapsedMicros * getCpuCoreCount())) * 100
        : 0;

    lastCpuUsage = process.cpuUsage();
    lastCpuSampleAt = now;
    latestRuntimeStats = {
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    };
  }

  function updateRuntimeInfo() {
    const model = shortenModelName(summarizer.getModel());
    const thinking = summarizer.getThinkingEffort();
    const pending = watcher.pendingEventCount;
    const pendingStr = pending > 0 ? ` | pending ${pending}` : "";
    const runtimeInfo =
      `model ${model} | think ${thinking} | rss ${formatMegabytes(latestRuntimeStats.rssBytes)} | cpu ${latestRuntimeStats.cpuPercent.toFixed(1)}%${pendingStr}`;
    ui.setRuntimeInfo(runtimeInfo);
  }

  logger.debug("APP", `Last summarized event ID: ${lastSummarizedEventId}`);

  ui.showWelcome(projectPath);
  refreshSummarizerConfig();
  refreshUiPreferences();
  sampleRuntimeStats();
  updateRuntimeInfo();

  const runtimeStatsInterval = setInterval(() => {
    sampleRuntimeStats();
    updateRuntimeInfo();
  }, 1000);

  function rememberTerminalLine(line: string) {
    terminalLineBuffer.push(line);
    if (terminalLineBuffer.length > TERMINAL_BUFFER_LIMIT) {
      terminalLineBuffer = terminalLineBuffer.slice(-TERMINAL_BUFFER_LIMIT);
    }
  }

  function buildCodeMatchesForDebug(logExcerpt: string, candidateFiles: string[]) {
    const matches: Array<{ path: string; language: string; snippet: string }> = [];
    const seenPaths = new Set<string>();

    for (const path of candidateFiles) {
      const file = store.getFile(path);
      if (!file || file.blocked) continue;
      matches.push({
        path: file.path,
        language: file.language,
        snippet: file.content.slice(0, 500),
      });
      seenPaths.add(file.path);
      if (matches.length >= 3) {
        return matches;
      }
    }

    for (const query of extractSearchQueriesFromLog(logExcerpt)) {
      for (const result of store.searchFiles({ query, limit: 3 })) {
        if (seenPaths.has(result.path)) continue;
        matches.push({
          path: result.path,
          language: result.language,
          snippet: result.snippet,
        });
        seenPaths.add(result.path);
        if (matches.length >= 3) {
          return matches;
        }
      }
    }

    return matches;
  }

  async function processDebugIncident(pending: PendingDebugIncident): Promise<void> {
    isDiagnosingDebugIncident = true;

    try {
      const codeMatches = buildCodeMatchesForDebug(
        pending.logExcerpt,
        pending.candidateFiles,
      );
      const diagnosis = await summarizer.generateDebugDiagnosis({
        trigger: pending.trigger,
        exitCode: pending.exitCode,
        signal: pending.signal,
        logExcerpt: pending.logExcerpt,
        recentEvents: pending.recentEvents,
        diffSummary: pending.diffSummary,
        codeMatches,
        previousSummary: lastSummary?.content,
        previousChatSummary: lastChatSummary?.content,
        workingMemory: store.getWorkingMemory(),
        userIntent: buildUserIntentContext(store),
      });

      const relatedFiles = normalizeRelatedFiles([
        ...diagnosis.relatedFiles,
        ...pending.candidateFiles,
      ]);

      store.updateDebugIncidentDiagnosis({
        id: pending.incidentId,
        headline: diagnosis.headline,
        summary: diagnosis.summary,
        relatedFiles,
      });

      const message = buildDebugIncidentMessage({
        headline: diagnosis.headline,
        summary: diagnosis.summary,
        relatedFiles,
      });
      await ui.showAssistantMessage(message, "debug");
      store.addMessage({
        role: "assistant",
        channel: "debug",
        content: message,
        sessionId,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? `Debug incident detected, but diagnosis failed: ${error.message}`
          : "Debug incident detected, but diagnosis failed.";
      logger.error("APP", "Debug diagnosis failed", error);
      store.updateDebugIncidentDiagnosis({
        id: pending.incidentId,
        headline: "Managed dev run failed",
        summary: message,
        relatedFiles: pending.candidateFiles,
      });
      ui.showError("Debug diagnosis failed", error as Error);
    } finally {
      isDiagnosingDebugIncident = false;
      if (queuedDebugIncident) {
        const nextIncident = queuedDebugIncident;
        queuedDebugIncident = null;
        void processDebugIncident(nextIncident);
      }
    }
  }

  function enqueueDebugIncident(input: {
    trigger: string;
    exitCode: number | null;
    signal: string | null;
    logExcerpt: string;
  }) {
    const candidateFiles = extractProjectPathsFromText(input.logExcerpt);
    const fingerprintSeed = [
      input.trigger,
      ...input.logExcerpt
        .split("\n")
        .slice(-TERMINAL_FINGERPRINT_LINES)
        .map(normalizeTerminalFingerprintLine),
      candidateFiles[0] ?? "",
    ].join("\n");
    const fingerprint = hashString(fingerprintSeed);
    const latestDiff = store.getRecentDiffSnapshots(1).at(0);
    const diffSnapshotId = latestDiff?.id ?? null;
    const now = Date.now();

    if (
      lastDebugIncidentFingerprint === fingerprint &&
      lastDebugIncidentDiffSnapshotId === diffSnapshotId &&
      now - lastDebugIncidentAt < DEBUG_INCIDENT_DEDUPE_WINDOW_MS
    ) {
      logger.debug("APP", "Skipping duplicate debug incident", { fingerprint });
      return;
    }

    lastDebugIncidentFingerprint = fingerprint;
    lastDebugIncidentAt = now;
    lastDebugIncidentDiffSnapshotId = diffSnapshotId;
    lastDebugSignalAt = now;

    const recentEvents = store
      .getRecentEvents(10)
      .filter(isCountableEvent)
      .reverse();
    const eventRangeEnd = recentEvents.at(-1)?.id ?? null;
    const incident = store.createDebugIncident({
      fingerprint,
      trigger: input.trigger,
      exitCode: input.exitCode,
      signal: input.signal,
      headline: "Managed dev run failed",
      summary: "",
      logExcerpt: input.logExcerpt,
      relatedFiles: candidateFiles,
      eventRangeEnd,
      diffSnapshotId,
    });

    const pending: PendingDebugIncident = {
      incidentId: incident.id,
      fingerprint,
      trigger: input.trigger,
      exitCode: input.exitCode,
      signal: input.signal,
      logExcerpt: input.logExcerpt,
      candidateFiles,
      recentEvents,
      eventRangeEnd,
      diffSnapshotId,
      diffSummary: latestDiff?.prompt,
    };

    if (isDiagnosingDebugIncident) {
      queuedDebugIncident = pending;
      return;
    }

    void processDebugIncident(pending);
  }

  function clearFatalBurstTimer() {
    if (fatalBurstTimer) {
      clearTimeout(fatalBurstTimer);
      fatalBurstTimer = null;
    }
  }

  function flushFatalBurst(trigger: string) {
    if (!pendingFatalBurst) return;

    const excerpt = terminalLineBuffer
      .slice(Math.max(0, fatalBurstStartIndex))
      .slice(-TERMINAL_INCIDENT_EXCERPT_LINES)
      .join("\n");

    pendingFatalBurst = false;
    clearFatalBurstTimer();
    sawFatalTerminalOutputSinceLastExit = false;

    if (!excerpt.trim()) return;

    enqueueDebugIncident({
      trigger,
      exitCode: null,
      signal: null,
      logExcerpt: excerpt,
    });
  }

  function scheduleFatalBurstDiagnosis() {
    clearFatalBurstTimer();
    fatalBurstTimer = setTimeout(() => {
      flushFatalBurst("managed dev pane emitted a fatal error burst");
    }, DEBUG_ERROR_BURST_DEBOUNCE_MS);
  }

  function handleManagedTerminalEvent(event: TerminalEventRecord) {
    ui.logTerminalEvent(event);
    rememberTerminalLine(event.data);

    if (isFatalTerminalLine(event.data)) {
      if (!pendingFatalBurst) {
        pendingFatalBurst = true;
        fatalBurstStartIndex = Math.max(0, terminalLineBuffer.length - 1);
      }
      sawFatalTerminalOutputSinceLastExit = true;
      scheduleFatalBurstDiagnosis();
    } else if (pendingFatalBurst && isBuildFailureLine(event.data)) {
      scheduleFatalBurstDiagnosis();
    }

    const trigger = parseManagedFailureTrigger(event.data);
    if (!trigger) return;

    clearFatalBurstTimer();
    const excerpt = terminalLineBuffer
      .slice(-TERMINAL_INCIDENT_EXCERPT_LINES)
      .join("\n");
    const triggerText =
      sawFatalTerminalOutputSinceLastExit
        ? `${trigger.trigger} after fatal terminal output`
        : trigger.trigger;

    sawFatalTerminalOutputSinceLastExit = false;
    if (!excerpt.trim()) return;

    enqueueDebugIncident({
      trigger: triggerText,
      exitCode: trigger.exitCode,
      signal: trigger.signal,
      logExcerpt: excerpt,
    });
  }

  const terminalPollInterval = setInterval(() => {
    if (!tmuxBootstrap.managed) {
      return;
    }

    const terminalEvents = store.getTerminalEventsSince(
      lastTerminalEventId,
      TERMINAL_POLL_BATCH_SIZE,
    );

    for (const event of terminalEvents) {
      lastTerminalEventId = event.id;
      handleManagedTerminalEvent(event);
    }
  }, 750);

  if (tmuxBootstrap.managed) {
    ui.showSuccess(`Dev terminal attached on the right (Ctrl+L to switch pane)`);
    ui.showInfo("Launching managed tmux session (chat + dev shell)");
  } else if (chatOnlyMode) {
    ui.showInfo("Chat-only mode enabled; skipping managed tmux dev terminal.");
  } else if (tmuxBootstrap.tmuxMissing) {
    ui.showError(
      "tmux is required for the split dev terminal; continuing in chat-only mode.",
    );
  }

  if (lastSummary) {
    await ui.showSummary(lastSummary.content);
  }

  if (INDEX_ON_START) {
    void performIndexing(process.env.CHAVES_FORCE_REINDEX === "true");
  }

  async function maybeSummarizeChatHistory() {
    if (isSummarizingChat) return;

    const pendingChatMessages = store.getMessagesSince(
      lastChatSummaryEndMessageId,
      "chat",
    );

    if (pendingChatMessages.length < CHAT_SUMMARY_THRESHOLD) return;

    const firstMessageId = pendingChatMessages[0]?.id;
    const lastMessageId = pendingChatMessages.at(-1)?.id;
    if (!firstMessageId || !lastMessageId) return;

    isSummarizingChat = true;

    try {
      const summary = await summarizer.generateChatSummary(
        pendingChatMessages,
        lastChatSummary?.content,
      );

      const savedSummary = store.saveChatSummary(
        summary,
        firstMessageId,
        lastMessageId,
      );

      lastChatSummary = savedSummary;
      lastChatSummaryEndMessageId = savedSummary.message_range_end;
      logger.debug(
        "APP",
        `Saved rolling chat summary up to message #${lastMessageId}`,
      );
    } catch (error) {
      logger.error("APP", "Chat summary generation failed", error);
    } finally {
      isSummarizingChat = false;
    }
  }

  async function maybeExtractMemory() {
    const pendingChatMessages = store.getMessagesSince(
      lastChatSummaryEndMessageId,
      "chat",
    );

    if (pendingChatMessages.length < 1) return;

    try {
      const currentMemory = store.getWorkingMemory();
      const updates = await summarizer.extractSessionMemory(
        pendingChatMessages,
        currentMemory,
      );

      if (Object.keys(updates).length > 0) {
        store.updateWorkingMemory(updates);
        logger.debug("APP", `Updated durable memory with ${Object.keys(updates).length} changes`);
      }
    } catch (error) {
      logger.error("APP", "Memory extraction failed", error);
    }
  }

  function applySessionGoalInsight(insight: ProactiveInsight): {
    shouldDisplay: boolean;
    message: string;
  } {
    const normalizedFiles = normalizeRelatedFiles(insight.relatedFiles);
    const nextState: SessionGoalState = {
      goal: insight.goal.trim(),
      focus: insight.focus.trim(),
      status: insight.status,
      suggestionKey: insight.suggestionKey.trim(),
      suggestionText: insight.suggestionText.trim(),
      relatedFiles: normalizedFiles,
      updatedAt: Date.now(),
    };

    const previousState = sessionGoalState;
    sessionGoalState = nextState;

    const sameSuggestion = previousState?.suggestionKey === nextState.suggestionKey;
    const goalChanged = previousState?.goal !== nextState.goal;
    const timeSinceLastUpdate = previousState ? Date.now() - previousState.updatedAt : Infinity;
    const suggestionExpired = timeSinceLastUpdate > 5 * 60 * 1000; // 5 minutes

    const alreadyActive = sameSuggestion && nextState.status === "active" && !suggestionExpired;
    const transitioned =
      previousState?.status !== nextState.status &&
      nextState.status !== "active";
    const shouldDisplay =
      insight.shouldNotify &&
      (!alreadyActive || suggestionExpired) &&
      (goalChanged || !sameSuggestion || transitioned || previousState === null || suggestionExpired);

    return {
      shouldDisplay,
      message: buildProactiveMessage({
        ...insight,
        relatedFiles: normalizedFiles,
      }),
    };
  }

  async function maybeGenerateProactiveInsight(input: {
    diffSummary?: string;
    recentEvents: ActivityEvent[];
    eventRangeEnd: number;
  }) {
    if (Date.now() - lastDebugSignalAt < PROACTIVE_DEBUG_COOLDOWN_MS) {
      logger.debug("APP", "Skipping proactive insight due to recent debug incident");
      lastSummarizedEventId = Math.max(lastSummarizedEventId, input.eventRangeEnd);
      eventsSinceLastSummary = store
        .getEventsSince(lastSummarizedEventId)
        .filter(isCountableEvent).length;
      return;
    }

    if (isSummarizing) return;

    isSummarizing = true;

    try {
      const insight = await summarizer.generateProactiveInsight({
        diffSummary: input.diffSummary,
        recentEvents: input.recentEvents,
        previousSummary: lastSummary?.content,
        previousChatSummary: lastChatSummary?.content,
        workingMemory: store.getWorkingMemory(),
        userIntent: buildUserIntentContext(store),
        previousInsight: sessionGoalState,
      });

      const { shouldDisplay, message } = applySessionGoalInsight(insight);
      const summaryRangeStart = lastSummarizedEventId;
      lastSummarizedEventId = Math.max(lastSummarizedEventId, input.eventRangeEnd);

      if (!shouldDisplay) {
        // Even if not displayed, we count this range as summarized
        return;
      }

      store.saveSummary(message, summaryRangeStart, input.eventRangeEnd);
      lastSummary = { content: message, event_range_end: input.eventRangeEnd };
      await ui.showSummary(message);
      store.addMessage({
        role: "assistant",
        channel: "proactive",
        content: message,
        sessionId,
      });
    } catch (error) {
      logger.error("APP", "Proactive insight generation failed:", error);
      if (error instanceof Error) {
        logger.error("APP", `Error details: ${error.message}`);
      }
    } finally {
      isSummarizing = false;
      // Reset events count since we just performed a proactive summary
      eventsSinceLastSummary = store
        .getEventsSince(lastSummarizedEventId)
        .filter(isCountableEvent).length;
    }
  }

  ui.onUserMessage(async (text) => {
    ui.setWatching(false);
    ui.setStatus("Thinking...");

    try {
      const slashOutput = await handleSlashCommand(text, store, {
        runtimeStats: latestRuntimeStats,
      });
      refreshSummarizerConfig();
      refreshUiPreferences();
      updateRuntimeInfo();
      if (slashOutput) {
        if (slashOutput.effect === "clear_context") {
          lastSummarizedEventId = 0;
          eventsSinceLastSummary = 0;
          isSummarizing = false;
          isSummarizingChat = false;
          lastEventSummaryPromptHash = null;
          lastSummary = null;
          lastChatSummary = null;
          lastChatSummaryEndMessageId = 0;
          sessionGoalState = null;
          ui.clearContext();
        }

        await ui.showAssistantMessage(slashOutput.output);
        store.addMessage({
          role: "assistant",
          channel: "info",
          content: slashOutput.output,
          sessionId,
        });
        return;
      }

      const savedUserMessage = store.addMessage({
        role: "user",
        channel: "chat",
        content: text,
        sessionId,
      });

      const recentChatMessages = store
        .getRecentMessages({
          limit: CHAT_CONTEXT_MESSAGES + 1,
          channel: "chat",
        })
        .filter((message) => message.id !== savedUserMessage.id);

      const fallbackContext = buildFallbackContext(store, text);
      const userIntent = buildUserIntentContext(store);
      const workingMemory = store.getWorkingMemory();
      let draftId: string | null = null;
      let streamedReply = "";
      let hasStreamedText = false;
      const reply = await summarizer.generateChat({
        userMessage: text,
        previousSummary: lastSummary?.content,
        previousChatSummary: lastChatSummary?.content,
        workingMemory,
        userIntent,
        recentMessages: mapToChatHistory(recentChatMessages),
        tools,
        fallbackContext,
        onStatus: async (status) => {
          ui.setStatus(status);
        },
        onTextDelta: async (delta) => {
          streamedReply += delta;
          hasStreamedText = true;
          ui.setStatus("Responding...");
          if (!draftId) {
            draftId = ui.startAssistantDraft("");
          }
          ui.updateMessage(draftId, {
            content: streamedReply,
            timestamp: Date.now(),
          });
        },
      });

      if (draftId) {
        await ui.finalizeAssistantDraft(draftId, hasStreamedText ? streamedReply : reply);
      } else {
        await ui.showAssistantMessage(reply);
      }
      store.addMessage({
        role: "assistant",
        channel: "chat",
        content: reply,
        sessionId,
      });

      await maybeSummarizeChatHistory();
      void maybeExtractMemory();
    } catch (error) {
      logger.error("APP", "Chat response failed:", error);
      ui.showError("Chat response failed", error as Error);
      store.addMessage({
        role: "assistant",
        channel: "error",
        content:
          error instanceof Error ? error.message : "Chat response failed",
        sessionId,
      });
    } finally {
      ui.setStatus("Watching...");
      ui.setWatching(true);
      ui.focusInput();
    }
  });

  async function runSummaryIfNeeded() {
    if (isSummarizing || eventsSinceLastSummary < SUMMARY_THRESHOLD) return;

    isSummarizing = true;
    logger.info("APP", "Summary threshold reached, generating fallback summary...");

    try {
      const newEvents = store.getEventsSince(lastSummarizedEventId);
      const countableEvents = newEvents.filter(isCountableEvent);

      logger.debug("APP", `Fetched ${newEvents.length} new events`, {
        countableEvents: countableEvents.length,
      });

      if (countableEvents.length === 0) {
        logger.warn("APP", "No countable events to summarize");
        return;
      }

      const lastEventId = newEvents.at(-1)?.id;
      if (!lastEventId) {
        logger.warn("APP", "No last event ID available for summary");
        return;
      }

      const uniqueFileCount = getUniqueFileCount(countableEvents);
      const isMeaningful =
        countableEvents.length >= SUMMARY_MIN_COUNTABLE_EVENTS ||
        uniqueFileCount >= SUMMARY_MIN_UNIQUE_FILES;

      if (!isMeaningful) {
        logger.info("APP", "Summary skipped (not enough meaningful change)", {
          countableEvents: countableEvents.length,
          uniqueFiles: uniqueFileCount,
        });
        lastSummarizedEventId = lastEventId;
        return;
      }

      const promptHash = hashString(
        summarizer.buildEventSummaryPrompt(
          countableEvents
            .map((event) => `[${event.timestamp}] ${event.event_type}: ${event.file_path}`)
            .join("\n"),
          lastSummary?.content,
        ),
      );

      if (lastEventSummaryPromptHash === promptHash) {
        logger.info("APP", "Summary skipped (prompt unchanged)");
        lastSummarizedEventId = lastEventId;
        return;
      }

      const startTime = Date.now();
      const summary = await summarizer.generateSummary(
        countableEvents,
        lastSummary?.content,
        buildUserIntentContext(store),
      );

      lastEventSummaryPromptHash = promptHash;
      store.saveSummary(summary, lastSummarizedEventId, lastEventId);
      lastSummarizedEventId = lastEventId;
      lastSummary = { content: summary, event_range_end: lastEventId };
      await ui.showSummary(summary);
      store.addMessage({
        role: "assistant",
        channel: "proactive",
        content: summary,
        sessionId,
      });

      logger.info("APP", `Summary done (${Date.now() - startTime}ms)`);
    } catch (error) {
      logger.error("APP", "Summary generation failed:", error);
      if (error instanceof Error) {
        logger.error("APP", `Error details: ${error.message}`);
      }
    } finally {
      isSummarizing = false;
      eventsSinceLastSummary = store
        .getEventsSince(lastSummarizedEventId)
        .filter(isCountableEvent).length;

      logger.debug(
        "APP",
        `Events since last summary: ${eventsSinceLastSummary}/${SUMMARY_THRESHOLD}`,
      );

      if (eventsSinceLastSummary >= SUMMARY_THRESHOLD) {
        await runSummaryIfNeeded();
      }
    }
  }

  watcher.on("event", async (event) => {
    logger.debug("APP", `Event: ${event.type}`, {
      path: event.path,
      details: event.details,
    });

    const saved = store.addEvent({
      event_type: event.type,
      file_path: event.path,
      details: event.details,
    });

    if (
      (event.type === "file_create" || event.type === "file_change") &&
      event.change &&
      (typeof event.change.after === "string" || event.change.blocked)
    ) {
      if (!event.change.blocked && event.change.before !== undefined) {
        const linesBefore = event.change.before.split("\n").length;
        const linesAfter = event.change.after?.split("\n").length ?? 0;
        const diff = linesAfter - linesBefore;
        const diffText = diff >= 0 ? `+${diff}` : `${diff}`;
        ui.showInfo(`Diff detected in ${event.path} (${diffText} lines)`);
      }
      try {
        store.upsertFile({
          path: event.path,
          content: event.change.after ?? "",
          language: event.change.language ?? "text",
          sizeBytes: Buffer.byteLength(event.change.after ?? "", "utf-8"),
          blocked: Boolean(event.change.blocked),
        });
      } catch (error) {
        logger.debug("APP", "Failed to update indexed file from watcher event", {
          path: event.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (event.type === "file_delete" && event.path) {
      try {
        store.deleteFile(event.path);
      } catch (error) {
        logger.debug("APP", "Failed to delete indexed file from watcher event", {
          path: event.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    ui.logEvent(saved);

    if (isCountableEventType(saved.event_type)) {
      eventsSinceLastSummary++;
    }

    logger.debug(
      "APP",
      `Events since last summary: ${eventsSinceLastSummary}/${SUMMARY_THRESHOLD}`,
    );

    await runSummaryIfNeeded();
  });

  watcher.on("summarize", async (payload) => {
    logger.debug("APP", "Summarize event", {
      changeCount: payload.changes.length,
    });

    if (!payload.prompt) return;

    try {
      store.saveDiffSnapshot(
        payload.prompt,
        JSON.stringify(payload.changes),
        payload.changes.length,
      );
      const recentEvents = store.getEventsSince(lastSummarizedEventId);
      const eventRangeEnd = recentEvents.at(-1)?.id ?? lastSummarizedEventId;
      await maybeGenerateProactiveInsight({
        diffSummary: payload.prompt,
        recentEvents,
        eventRangeEnd,
      });
    } catch (error) {
      logger.error("APP", "Diff summary failed:", error);
      if (error instanceof Error) {
        logger.error("APP", `Error details: ${error.message}`);
      }
    }
  });

  watcher.start();

  logger.info("APP", "CHAVES is now running");

  let cleanedUp = false;

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(runtimeStatsInterval);
    clearInterval(terminalPollInterval);
    clearFatalBurstTimer();
    watcher.stop();
    ui.destroy();
    if (isInsideManagedTmuxSession()) {
      killManagedSession();
    }
  }

  process.on("exit", () => {
    if (isInsideManagedTmuxSession()) {
      killManagedSession();
    }
  });

  process.on("SIGINT", () => {
    logger.appStop();
    cleanup();
    console.log("\nChaves offline");
    process.exit(0);
  });

  process.on("uncaughtException", (error) => {
    logger.error("APP", "Uncaught exception:", error);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("APP", "Unhandled rejection:", reason);
  });
}

main().catch((error) => {
  logger.error("APP", "Failed to start:", error);
  const message = error instanceof Error
    ? `${error.message}${error.stack ? "\n" + error.stack : ""}`
    : String(error);
  process.stderr.write(`[chaves] Fatal: ${message}\n`);
  process.exit(1);
});
