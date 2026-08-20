import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, streamText } from "ai";
import { logger } from "./logger.js";
import { shield } from "./shield.js";
import type { ActivityEvent, StoredMessage } from "./store.js";

type ChatRole = "user" | "assistant" | "system";

export type MessageFrequencyLevel = 1 | 2 | 3;
export type Personality = "technical" | "collaborative" | "creative";
export type ThinkingEffort = "low" | "medium" | "high";
export type ProactiveInsightStatus = "active" | "addressed" | "ignored" | "irrelevant";

export interface ChatHistoryMessage {
  role: ChatRole;
  content: string;
}

export interface ProactiveInsight {
  goal: string;
  focus: string;
  status: ProactiveInsightStatus;
  suggestionKey: string;
  suggestionText: string;
  relatedFiles: string[];
  shouldNotify: boolean;
}

export interface SessionGoalContext {
  goal: string;
  focus: string;
  status: ProactiveInsightStatus;
  suggestionKey: string;
  suggestionText: string;
  relatedFiles: string[];
}

interface GenerateChatInput {
  userMessage: string;
  previousSummary?: string;
  previousChatSummary?: string;
  workingMemory?: Record<string, string>;
  userIntent?: string;
  recentMessages?: ChatHistoryMessage[];
  tools?: Record<string, unknown>;
  fallbackContext?: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onStatus?: (status: string) => void | Promise<void>;
}

interface GenerateProactiveInsightInput {
  diffSummary?: string;
  recentEvents?: ActivityEvent[];
  previousSummary?: string;
  previousChatSummary?: string;
  workingMemory?: Record<string, string>;
  userIntent?: string;
  previousInsight?: SessionGoalContext | null;
}

interface GenerateDebugDiagnosisInput {
  trigger: string;
  exitCode?: number | null;
  signal?: string | null;
  logExcerpt: string;
  recentEvents?: ActivityEvent[];
  diffSummary?: string;
  codeMatches?: Array<{
    path: string;
    language: string;
    snippet: string;
  }>;
  previousSummary?: string;
  previousChatSummary?: string;
  workingMemory?: Record<string, string>;
  userIntent?: string;
}

export interface DebugDiagnosis {
  headline: string;
  summary: string;
  relatedFiles: string[];
}

function normalizeDiagnosisFiles(paths: string[] | undefined): string[] {
  return Array.isArray(paths)
    ? paths
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 3)
    : [];
}

export interface SummarizerOptions {
  model?: string;
  language?: string;
  apiKey?: string;
  frequencyLevel?: MessageFrequencyLevel;
  personality?: Personality;
  thinkingEffort?: ThinkingEffort;
}

export class Summarizer {
  private client: ReturnType<typeof createOpenRouter>;
  private model: string;
  private language: string;
  private apiKey?: string;
  private frequencyLevel: MessageFrequencyLevel;
  private personality: Personality;
  private thinkingEffort: ThinkingEffort;

  constructor(options: SummarizerOptions = {}) {
    this.model = options.model ?? "anthropic/claude-3.5-haiku";
    this.language = options.language ?? "en";
    this.apiKey = options.apiKey ?? "";
    this.frequencyLevel = options.frequencyLevel ?? 2;
    this.personality = options.personality ?? "collaborative";
    this.thinkingEffort = options.thinkingEffort ?? "medium";

    logger.debug("AI", "Initializing OpenRouter client");
    this.client = createOpenRouter({
      apiKey: this.apiKey,
    });
    logger.debug("AI", "OpenRouter client initialized");
    logger.debug("AI", `Using model: ${this.model}`);
    logger.debug("AI", `Using language: ${this.language}`);
    logger.debug("AI", `Using thinking effort: ${this.thinkingEffort}`);

    if (!this.apiKey) {
      logger.warn("AI", "OpenRouter API key not set - AI features will fail");
    }
  }

  getModel(): string {
    return this.model;
  }

  private assertConfigured(): void {
    if (!this.apiKey?.trim()) {
      throw new Error(
        "OpenRouter API key is not configured. Run /setup to set your key.",
      );
    }
  }

  setModel(model: string) {
    this.model = model.trim() || "anthropic/claude-3.5-haiku";
    logger.debug("AI", `Model updated: ${this.model}`);
  }

  setLanguage(language: string) {
    this.language = language.trim() || "en";
    logger.debug("AI", `Language updated: ${this.language}`);
  }

  setFrequencyLevel(level: MessageFrequencyLevel) {
    this.frequencyLevel = level;
    logger.debug("AI", `Frequency level updated: ${this.frequencyLevel}`);
  }

  setPersonality(personality: Personality) {
    this.personality = personality;
    logger.debug("AI", `Personality updated: ${this.personality}`);
  }

  getThinkingEffort(): ThinkingEffort {
    return this.thinkingEffort;
  }

  setThinkingEffort(effort: ThinkingEffort) {
    this.thinkingEffort = effort;
    logger.debug("AI", `Thinking effort updated: ${this.thinkingEffort}`);
  }

  private buildChatModel() {
    return this.client.chat(this.model, {
      reasoning: {
        effort: this.thinkingEffort,
      },
    });
  }

  private supportsToolCalling(): boolean {
    // OpenRouter provides a unified interface for tool calling across most modern models.
    // Instead of a strict whitelist, we now allow tool calling by default.
    return true;
  }

  private isLikelyCodeQuery(text: string): boolean {
    // Treat almost everything as a potential code query to avoid hallucinations
    // unless it's extremely short or clearly just social filler.
    if (text.length < 3) return false;

    // Broaden regex to include common question words in EN and PT
    return /(where|implement|function|class|method|module|file|path|src\/|\.ts|\.js|\.tsx|\.jsx|error|bug|fix|stack|trace|why|what|how|who|list|tell|explain|que|como|onde|quem|fazer|mostra|explica|ajuda|projeto|build|context)/i
      .test(text);
  }

  async generateSummary(
    events: ActivityEvent[],
    previousSummary?: string,
    userIntent?: string,
  ): Promise<string> {
    this.assertConfigured();
    logger.debug("AI", `Generating summary for ${events.length} events`);

    const eventCounts = events
      .map((event) => {
        const path = event.file_path ?? "";
        const base = path.split("/").pop() ?? path;
        return `${event.event_type}:${base}`;
      })
      .reduce<Record<string, number>>((acc, key) => {
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});

    const eventLog = Object.entries(eventCounts)
      .map(([key, count]) => (count > 1 ? `${key}x${count}` : key))
      .join(";");

    logger.debug("AI", "Event log", eventLog);

    const system = this.buildSummarySystemPrompt();
    const prompt = shield.sanitize(
      this.buildEventSummaryPrompt(eventLog, previousSummary, userIntent),
    );

    const maxTokensByLevel: Record<MessageFrequencyLevel, number> = {
      1: 300,
      2: 500,
      3: 800,
    };

    logger.aiRequest(prompt.length);

    try {
      const { text } = await generateText({
        model: this.buildChatModel(),
        maxTokens: maxTokensByLevel[this.frequencyLevel],
        system,
        prompt,
      });

      logger.aiResponse(text.length);
      if (text.trim().length === 0) {
        throw new Error("Empty summary returned from AI provider");
      }

      return text;
    } catch (error) {
      logger.aiError(error);
      throw error;
    }
  }

  buildEventSummaryPrompt(
    eventLog: string,
    previousSummary?: string,
    userIntent?: string,
  ): string {
    const parts: string[] = [];

    if (previousSummary) {
      parts.push(`Previous context:\n${shield.sanitize(previousSummary)}`);
    }

    if (userIntent) {
      parts.push(`Recent explicit user guidance:\n${shield.sanitize(userIntent)}`);
    }

    parts.push(
      [
        "Recent IDE activity:",
        eventLog,
        "",
        "Instructions:",
        "1. Identify the user's current focus (e.g. 'Refactoring the Auth service').",
        "2. State the most recent step taken.",
        "3. Suggest the most logical next step.",
        "Ensure the summary is cohesive and complete.",
      ].join("\n"),
    );

    return parts.join("\n\n");
  }

  buildDiffSummaryPrompt(
    diffSummary: string,
    previousSummary?: string,
    userIntent?: string,
  ): string {
    const parts: string[] = [];

    if (previousSummary) {
      parts.push(`Previous context:\n${shield.sanitize(previousSummary)}`);
    }

    if (userIntent) {
      parts.push(`Recent explicit user guidance:\n${shield.sanitize(userIntent)}`);
    }

    parts.push(
      [
        "File diffs:",
        shield.sanitize(diffSummary),
        "",
        "Instructions:",
        "Analyze these changes and summarize:",
        "- The core intent of the modification.",
        "- The technical scope (what was touched).",
        "- The most logical next step for the user.",
        "Maintain a professional and helpful tone.",
      ].join("\n"),
    );

    return parts.join("\n\n");
  }

  async generateDiff(
    diffSummary: string,
    previousSummary?: string,
    userIntent?: string,
  ): Promise<string> {
    this.assertConfigured();
    const system = this.buildSummarySystemPrompt();
    const prompt = this.buildDiffSummaryPrompt(
      diffSummary,
      previousSummary,
      userIntent,
    );

    const maxTokensByLevel: Record<MessageFrequencyLevel, number> = {
      1: 400,
      2: 600,
      3: 1000,
    };

    logger.aiRequest(prompt.length);

    const { text } = await generateText({
      model: this.buildChatModel(),
      maxTokens: maxTokensByLevel[this.frequencyLevel],
      system,
      prompt,
    });

    if (text.trim().length === 0) {
      throw new Error("Empty summary returned from AI provider");
    }

    logger.aiResponse(text.length);
    return text;
  }

  async generateChat(input: GenerateChatInput): Promise<string> {
    this.assertConfigured();
    const useTools =
      Boolean(input.tools) &&
      this.supportsToolCalling() &&
      this.isLikelyCodeQuery(input.userMessage);
    const system = this.buildChatSystemPrompt();
    const messages = this.buildChatMessages({
      userMessage: input.userMessage,
      recentMessages: input.recentMessages ?? [],
      previousSummary: input.previousSummary,
      previousChatSummary: input.previousChatSummary,
      workingMemory: input.workingMemory,
      userIntent: input.userIntent,
      useTools,
      fallbackContext:
        !useTools && this.isLikelyCodeQuery(input.userMessage)
          ? input.fallbackContext
          : undefined,
    });

    try {
      return await this.generateChatCompletion({
        system,
        messages,
        tools: useTools ? input.tools : undefined,
        onTextDelta: input.onTextDelta,
        onStatus: input.onStatus,
      });
    } catch (error) {
      if (!useTools) throw error;

      logger.warn(
        "AI",
        "Tool-calling failed for chat; retrying once without tools",
      );
      logger.debug("AI", "Tool-calling error details", error);

      const fallbackMessages = this.buildChatMessages({
        userMessage: input.userMessage,
        recentMessages: input.recentMessages ?? [],
        previousSummary: input.previousSummary,
        previousChatSummary: input.previousChatSummary,
        userIntent: input.userIntent,
        fallbackContext: input.fallbackContext,
      });

      return this.generateChatCompletion({
        system,
        messages: fallbackMessages,
        onTextDelta: input.onTextDelta,
        onStatus: input.onStatus,
      });
    }
  }

  async generateChatSummary(
    messages: StoredMessage[],
    previousChatSummary?: string,
  ): Promise<string> {
    this.assertConfigured();
    const transcript = messages
      .map((message) => {
        const role = message.role.toUpperCase();
        return `[${message.timestamp}] ${role}: ${shield.sanitize(message.content)}`;
      })
      .join("\n");

    const promptParts = [
      "Create a compact long-term memory summary of this chat.",
      "Keep durable decisions, user preferences, unresolved questions, and current objective.",
      "Omit filler and repetition.",
    ];

    if (previousChatSummary) {
      promptParts.push(`Previous chat memory:\n${previousChatSummary}`);
    }

    promptParts.push(`Recent chat transcript:\n${transcript}`);

    const prompt = shield.sanitize(promptParts.join("\n\n"));
    const system = this.buildSummarySystemPrompt();

    logger.aiRequest(prompt.length);

    const { text } = await generateText({
      model: this.buildChatModel(),
      system,
      prompt,
      maxTokens: 320,
    });

    if (text.trim().length === 0) {
      throw new Error("Empty chat summary returned from AI provider");
    }

    logger.aiResponse(text.length);
    return text;
  }

  async extractSessionMemory(
    messages: StoredMessage[],
    currentMemory: Record<string, string>,
  ): Promise<Record<string, string | null>> {
    this.assertConfigured();

    const transcript = messages
      .map((message) => {
        const role = message.role.toUpperCase();
        return `[${message.timestamp}] ${role}: ${shield.sanitize(message.content)}`;
      })
      .join("\n");

    const currentMemoryStr =
      Object.entries(currentMemory)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n") || "(empty)";

    const prompt = [
      "You are the Memory Manager for Chaves, a coding companion.",
      "Your task is to analyze the recent chat transcript and update the durable project memory.",
      "",
      "CRITICAL: Output a single JSON object ONLY. No preamble or postscript.",
      "",
      "Goals for memory:",
      "1. Long-term preferences (e.g., 'prefers Vitest over Jest', 'likes early returns').",
      "2. Project-wide context (e.g., 'we are migrating to a monorepo', 'the main branch is protected').",
      "3. Long-running goals (e.g., 'working on the auth flow refactor').",
      "",
      "SCHEMA:",
      "{ \"key-name\": \"updated fact string or null to delete\" }",
      "",
      "EXAMPLE:",
      "Chat: 'Actually, let's use Vitest instead of Jest for this project.'",
      "Memory: { \"testing-framework\": \"Vitest\" }",
      "",
      "Current Memory state:",
      currentMemoryStr,
      "",
      "Recent Chat transcript:",
      transcript,
    ].join("\n");

    logger.aiRequest(prompt.length);

    try {
      const { text } = await generateText({
        model: this.buildChatModel(),
        system: "You are a precise memory extraction agent. Return JSON only.",
        prompt,
      });

      logger.aiResponse(text.length);

      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) return {};

      const updates = JSON.parse(text.slice(start, end + 1));
      return updates;
    } catch (error) {
      logger.debug("AI", "Failed to extract session memory", error);
      return {};
    }
  }

  async generateProactiveInsight(
    input: GenerateProactiveInsightInput,
  ): Promise<ProactiveInsight> {
    this.assertConfigured();

    const sections: string[] = [];
    sections.push(
      "Analyze the current coding session and return a single JSON object ONLY.",
      "Your goal is to infer the user's short-term objective, identify their current technical focus, and provide a high-value suggestion.",
      "HIGH-SIGNAL ADVICE: Your suggestionText must be highly specific, actionable, and technically relevant. Identify potential bugs, architectural gaps, or the immediate next logical implementation step.",
      "Assess the status of the previous suggestion (active, addressed, ignored, or irrelevant).",
      "NOTIFICATION RULE: Set shouldNotify=true whenever you have a concrete, helpful suggestion. Only set shouldNotify=false if the recent activity is purely trivial (e.g. whitespace only) or if there is no clear direction yet.",
      'Return JSON with keys: goal, focus, status, suggestionKey, suggestionText, relatedFiles, shouldNotify.',
    );

    if (input.previousSummary) {
      sections.push(`Previous coding summary:\n${shield.sanitize(input.previousSummary)}`);
    }

    if (input.previousChatSummary) {
      sections.push(`Rolling chat memory:\n${shield.sanitize(input.previousChatSummary)}`);
    }

    if (input.workingMemory && Object.keys(input.workingMemory).length > 0) {
      const memoryLines = Object.entries(input.workingMemory)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join("\n");
      sections.push(`Durable Project Memory & Preferences:\n${memoryLines}`);
    }

    if (input.userIntent) {
      sections.push(`Recent explicit user guidance:\n${shield.sanitize(input.userIntent)}`);
    }

    if (input.previousInsight) {
      sections.push(
        [
          "Previous session goal state:",
          `goal: ${input.previousInsight.goal}`,
          `focus: ${input.previousInsight.focus}`,
          `status: ${input.previousInsight.status}`,
          `suggestionKey: ${input.previousInsight.suggestionKey}`,
          `suggestionText: ${input.previousInsight.suggestionText}`,
          `relatedFiles: ${input.previousInsight.relatedFiles.join(", ") || "(none)"}`,
        ].join("\n"),
      );
    }

    if (input.diffSummary?.trim()) {
      sections.push(`Latest diff snapshot:\n${shield.sanitize(input.diffSummary)}`);
    }

    if ((input.recentEvents?.length ?? 0) > 0) {
      sections.push(
        [
          "Recent events:",
          ...(input.recentEvents ?? []).map(
            (event) =>
              `- [${event.timestamp}] ${event.event_type} ${event.file_path || ""}`.trim(),
          ),
        ].join("\n"),
      );
    }

    const prompt = shield.sanitize(sections.join("\n\n"));
    logger.aiRequest(prompt.length);

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30_000);

    try {
      const { text } = await generateText({
        model: this.buildChatModel(),
        system: this.buildSummarySystemPrompt(),
        prompt,
        maxTokens: 800,
        abortSignal: abortController.signal,
      });

      clearTimeout(timeout);

      if (text.trim().length === 0) {
        throw new Error("Empty proactive insight returned from AI provider");
      }

      logger.aiResponse(text.length);
      return this.parseProactiveInsight(text);
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  }

  async generateDebugDiagnosis(
    input: GenerateDebugDiagnosisInput,
  ): Promise<DebugDiagnosis> {
    this.assertConfigured();

    const sections: string[] = [
      "Analyze this failed managed dev run and return a single JSON object only.",
      "Your task is to diagnose the failure conservatively from the provided logs and recent coding context.",
      'Return JSON with keys: headline, summary, relatedFiles.',
      "headline: one short sentence naming the failure.",
      "summary: 2-4 short paragraphs or bullets covering likely root cause, evidence from logs, and the next concrete fix to try.",
      "relatedFiles: up to 3 project-relative file paths that are most relevant to the fix.",
      "Do not claim certainty when the logs are ambiguous.",
      "Do not suggest generic advice like checking the logs or restarting unless it is truly the best next action.",
      "Do not propose automatic edits or command execution.",
      "CRITICAL: Return JSON only. No markdown fences. No prose outside the JSON object.",
    ];

    sections.push(`Failure trigger: ${shield.sanitize(input.trigger)}`);
    if (input.exitCode !== undefined && input.exitCode !== null) {
      sections.push(`Exit code: ${input.exitCode}`);
    }
    if (input.signal) {
      sections.push(`Signal: ${shield.sanitize(input.signal)}`);
    }

    if (input.previousSummary) {
      sections.push(`Previous coding summary:\n${shield.sanitize(input.previousSummary)}`);
    }

    if (input.previousChatSummary) {
      sections.push(`Rolling chat memory:\n${shield.sanitize(input.previousChatSummary)}`);
    }

    if (input.workingMemory && Object.keys(input.workingMemory).length > 0) {
      const memoryLines = Object.entries(input.workingMemory)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join("\n");
      sections.push(`Durable Project Memory & Preferences:\n${memoryLines}`);
    }

    if (input.userIntent) {
      sections.push(`Recent explicit user guidance:\n${shield.sanitize(input.userIntent)}`);
    }

    if (input.diffSummary?.trim()) {
      sections.push(`Latest diff snapshot:\n${shield.sanitize(input.diffSummary)}`);
    }

    if ((input.recentEvents?.length ?? 0) > 0) {
      sections.push(
        [
          "Recent filesystem events:",
          ...(input.recentEvents ?? []).map(
            (event) =>
              `- [${event.timestamp}] ${event.event_type} ${event.file_path || ""}`.trim(),
          ),
        ].join("\n"),
      );
    }

    if ((input.codeMatches?.length ?? 0) > 0) {
      sections.push(
        [
          "Relevant indexed code matches:",
          ...(input.codeMatches ?? []).map(
            (match, index) =>
              `${index + 1}. ${match.path} (${match.language})\n${shield.sanitize(match.snippet)}`,
          ),
        ].join("\n"),
      );
    }

    sections.push(`Failure log excerpt:\n${shield.sanitize(input.logExcerpt)}`);

    const prompt = shield.sanitize(sections.join("\n\n"));
    logger.aiRequest(prompt.length);

    const { text } = await generateText({
      model: this.buildChatModel(),
      system: this.buildSummarySystemPrompt(),
      prompt,
      maxTokens: 900,
    });

    if (text.trim().length === 0) {
      throw new Error("Empty debug diagnosis returned from AI provider");
    }

    logger.aiResponse(text.length);
    try {
      return this.parseDebugDiagnosis(text);
    } catch (error) {
      logger.debug("AI", "Debug diagnosis JSON parse failed, using heuristic fallback", error);
      return this.buildFallbackDebugDiagnosis(input);
    }
  }

  private async generateChatCompletion(input: {
    system: string;
    messages: Array<{ role: ChatRole; content: string }>;
    tools?: Record<string, unknown>;
    onTextDelta?: (delta: string) => void | Promise<void>;
    onStatus?: (status: string) => void | Promise<void>;
  }): Promise<string> {
    const toolEnabled = Boolean(input.tools);
    const abortController = new AbortController();
    const timeoutMs = 60_000; // slightly longer for multi-step tools
    const timeout = setTimeout(() => {
      abortController.abort(
        new Error(`AI provider timed out after ${Math.floor(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);

    const maxTokensByLevel: Record<MessageFrequencyLevel, number> = {
      1: 1200,
      2: 3000,
      3: 4200,
    };

    try {
      await input.onStatus?.("Thinking...");

      const result = await streamText({
        model: this.buildChatModel(),
        system: input.system,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: shield.sanitize(message.content),
        })),
        tools: input.tools as any,
        toolChoice: toolEnabled ? "auto" : undefined,
        maxSteps: toolEnabled ? 5 : undefined,
        maxTokens: maxTokensByLevel[this.frequencyLevel],
        abortSignal: abortController.signal,
        onStepFinish: toolEnabled
          ? async (step) => {
              if ((step.toolCalls?.length ?? 0) > 0) {
                await input.onStatus?.("Calling tools...");
              } else {
                await input.onStatus?.("Thinking...");
              }
            }
          : undefined,
      });

      let fullText = "";
      for await (const textDelta of result.textStream) {
        fullText += textDelta;
        if (input.onTextDelta) {
          await input.onTextDelta(textDelta);
        }
      }

      if (fullText.trim().length === 0) {
        throw new Error("Empty response returned from AI provider");
      }

      logger.aiResponse(fullText.length);
      return fullText;
    } catch (error) {
      logger.aiError(error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildSummarySystemPrompt(): string {
    const lang = this.formatLanguageForPrompt(this.language);
    const verbosity = this.verbosityGuidance("summary");
    const personality = this.personalityGuidance();

    return [
      "You are Chaves, a coding companion working alongside the user.",
      `Respond in ${lang} only. No other language.`,
      verbosity,
      personality,
      "CRITICAL: Always complete your thoughts and sentences. Do not stop mid-sentence.",
      "If explicit user guidance conflicts with inferred activity, explicit user guidance wins.",
      "Be grounded in the provided context. Do not claim actions were taken unless explicitly stated.",
    ].join("\n");
  }

  private buildChatSystemPrompt(): string {
    const lang = this.formatLanguageForPrompt(this.language);
    const verbosity = this.verbosityGuidance("chat");
    const personality = this.personalityGuidance();

    return [
      "You are Chaves, a code companion.",
      `Respond in ${lang} only.`,
      verbosity,
      personality,
      "DISCOVERY FIRST: Do not assume what the project is. Use tools to check the README.md, package.json, or list files to verify what you are working on before giving summary advice.",
      "Latest explicit user guidance overrides any inferred direction from file activity or prior summaries.",
      "If the user corrects the current direction, immediately pivot to the corrected goal and stop defending the previous inference.",
      "When codebase facts are needed, use ONLY the following tools: [recent_events, recent_diffs, get_diff, get_file, search_code, terminal_output, list_files].",
      "Do not assume any other tools exist (e.g., list_directory, read_file, run_shell_command are NOT available).",
      "Do not edit files or run commands; provide advisory guidance only.",
      "Do not claim actions were executed unless explicitly in context.",
    ].join("\n");
  }

  private verbosityGuidance(kind: "chat" | "summary"): string {
    if (this.frequencyLevel === 1) {
      return kind === "chat"
        ? "Be concise: 1-3 complete sentences. High-signal only."
        : "Be concise: 1-2 complete sentences. Do not use bullets. Ensure you finish the thought.";
    }

    if (this.frequencyLevel === 3) {
      return kind === "chat"
        ? "Be comprehensive: explain reasoning, include structure (short bullets/sections are allowed), and provide concrete next steps."
        : "Be comprehensive: include more detail and concrete next steps. Short bullets are allowed. Always finish every section.";
    }

    return kind === "chat"
      ? "Be standard: concise conversational flow; expand when it increases clarity. Always finish your sentences."
      : "Be standard: concise but clear, with a concrete next step. Ensure the output is complete.";
  }

  private personalityGuidance(): string {
    switch (this.personality) {
      case "technical":
        return "Style: technical and precise; focus on implementation details; avoid analogies.";
      case "creative":
        return "Style: creative; propose alternatives and examples; stay grounded in facts.";
      case "collaborative":
      default:
        return "Style: collaborative; use 'we' when appropriate; ask clarifying questions only when necessary.";
    }
  }

  private formatLanguageForPrompt(language: string): string {
    if (language === "pt" || language === "pt-BR") return "portuguese (Brazil)";
    return language;
  }

  private parseProactiveInsight(raw: string): ProactiveInsight {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Proactive insight response was not valid JSON");
    }

    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<ProactiveInsight>;
    const statuses: ProactiveInsightStatus[] = [
      "active",
      "addressed",
      "ignored",
      "irrelevant",
    ];
    const status = statuses.includes(parsed.status as ProactiveInsightStatus)
      ? (parsed.status as ProactiveInsightStatus)
      : "active";

    return {
      goal: (parsed.goal ?? "").trim() || "Continue the current coding task",
      focus: (parsed.focus ?? "").trim() || "Recent code changes",
      status,
      suggestionKey: (parsed.suggestionKey ?? "").trim() || "continue-current-work",
      suggestionText: (parsed.suggestionText ?? "").trim() || "Continue the current implementation path.",
      relatedFiles: Array.isArray(parsed.relatedFiles)
        ? parsed.relatedFiles
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 5)
        : [],
      shouldNotify: Boolean(parsed.shouldNotify),
    };
  }

  private parseDebugDiagnosis(raw: string): DebugDiagnosis {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Debug diagnosis response was not valid JSON");
    }

    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<DebugDiagnosis>;

    return {
      headline: (parsed.headline ?? "").trim() || "Managed dev run failed",
      summary:
        (parsed.summary ?? "").trim() ||
        "The managed dev command failed, but the diagnosis response was empty.",
      relatedFiles: normalizeDiagnosisFiles(parsed.relatedFiles),
    };
  }

  private buildFallbackDebugDiagnosis(input: GenerateDebugDiagnosisInput): DebugDiagnosis {
    const log = input.logExcerpt;
    const locationMatch = log.match(/([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json)):(\d+):(\d+)/);
    const expectedMatch = log.match(/Expected\s+(.+?)\s+but found\s+(.+)/i);
    const relatedFiles = normalizeDiagnosisFiles([
      ...(locationMatch ? [locationMatch[1] ?? ""] : []),
      ...(input.codeMatches?.map((match) => match.path) ?? []),
    ]);

    if (locationMatch && expectedMatch) {
      const file = locationMatch[1];
      const line = locationMatch[2];
      return {
        headline: `Syntax error in ${file}`,
        summary: [
          `The dev server hit a parser error in ${file}:${line}.`,
          `The log says it expected ${expectedMatch[1]} but found ${expectedMatch[2]}, which usually means the object or statement just above that token is malformed.`,
          `The next fix is to inspect the surrounding lines in ${file} and correct the syntax before retrying the build.`,
        ].join("\n\n"),
        relatedFiles,
      };
    }

    if (/module not found|cannot find module/i.test(log)) {
      return {
        headline: "Missing module or import resolution failure",
        summary: [
          "The managed dev run failed because a module import could not be resolved.",
          "The next fix is to inspect the reported import path, verify the target file exists, and align the import path or package dependency with the current project structure.",
        ].join("\n\n"),
        relatedFiles,
      };
    }

    return {
      headline: "Managed dev run failed",
      summary: [
        `The managed dev pane reported a fatal build/runtime failure via ${input.trigger}.`,
        "CHAVES could not parse a structured diagnosis from the model response, but the failure log was captured and stored.",
        "The next fix is to inspect the last reported error location or stack frame in the captured log and correct that source first.",
      ].join("\n\n"),
      relatedFiles,
    };
  }

  private buildChatMessages(input: {
    userMessage: string;
    recentMessages: ChatHistoryMessage[];
    previousSummary?: string;
    previousChatSummary?: string;
    workingMemory?: Record<string, string>;
    userIntent?: string;
    fallbackContext?: string;
    useTools?: boolean;
  }): Array<{ role: ChatRole; content: string }> {
    const messages: Array<{ role: ChatRole; content: string }> = [];
    const contextSections: string[] = [];

    if (input.previousSummary) {
      contextSections.push(
        `Latest coding summary:\n${shield.sanitize(input.previousSummary)}`,
      );
    }

    if (input.previousChatSummary) {
      contextSections.push(
        `Rolling chat memory:\n${shield.sanitize(input.previousChatSummary)}`,
      );
    }

    if (input.workingMemory && Object.keys(input.workingMemory).length > 0) {
      const memoryLines = Object.entries(input.workingMemory)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join("\n");
      contextSections.push(`Durable Project Memory & Preferences:\n${memoryLines}`);
    }

    if (input.userIntent) {
      contextSections.push(
        `Recent explicit user guidance (highest priority):\n${shield.sanitize(input.userIntent)}`,
      );
    }

    if (input.useTools) {
      contextSections.push(
        "Project context is available via tools: [recent_events, recent_diffs, get_diff, get_file, search_code, terminal_output, list_files]. Use these tools when specific codebase facts are needed. Do not assume any other tools exist.",
      );
    } else {
      contextSections.push(
        "Tools are NOT available for this specific turn. Rely on the provided context or ask the user for more information.",
      );
    }

    if (input.fallbackContext) {
      contextSections.push(
        `Fallback context snapshot:\n${shield.sanitize(input.fallbackContext)}`,
      );
    }

    messages.push({
      role: "system",
      content: contextSections.join("\n\n"),
    });

    for (const message of input.recentMessages) {
      messages.push({
        role: message.role,
        content: shield.sanitize(message.content),
      });
    }

    messages.push({
      role: "user",
      content: shield.sanitize(input.userMessage),
    });

    return messages;
  }
}
