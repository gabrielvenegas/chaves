import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
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
  userIntent?: string;
  previousInsight?: SessionGoalContext | null;
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
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
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
      logger.warn("AI", "OPENROUTER_API_KEY not set - AI features will fail");
    }
  }

  getModel(): string {
    return this.model;
  }

  private assertConfigured(): void {
    if (!this.apiKey?.trim()) {
      throw new Error(
        "OpenRouter API key is not configured. Run /setup or set OPENROUTER_API_KEY.",
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
    const model = this.model.trim().toLowerCase();
    return model.startsWith("openai/") || model.startsWith("anthropic/");
  }

  private isLikelyCodeQuery(text: string): boolean {
    return /(where|implement|function|class|method|module|file|path|src\/|\.ts|\.js|\.tsx|\.jsx|error|bug|fix|stack|trace|why)/i
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
      1: 180,
      2: 220,
      3: 400,
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
      `Recent IDE activity:\n${eventLog}\n\nSummarize current focus, most recent step, and likely next step.`,
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
      `File diffs:\n${shield.sanitize(diffSummary)}\n\nSummarize intent, scope, and next steps.`,
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
      1: 240,
      2: 320,
      3: 520,
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
      "Goals for memory:",
      "1. Long-term preferences (e.g., 'prefers Vitest over Jest', 'likes early returns').",
      "2. Project-wide context (e.g., 'we are migrating to a monorepo', 'the main branch is protected').",
      "3. Long-running goals (e.g., 'working on the auth flow refactor').",
      "",
      "Current Memory state:",
      currentMemoryStr,
      "",
      "Recent Chat transcript:",
      transcript,
      "",
      "Output a single JSON object where keys are the memory identifiers and values are the updated strings.",
      "Use null as a value to DELETE a key if it is no longer relevant.",
      "Only include keys that NEED to be updated or deleted.",
      "Keys should be concise (kebab-case). Values should be clear facts.",
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

    const sections: string[] = [
      "Analyze the current coding session and return a single JSON object only.",
      "Infer the user's short-term goal, current focus, and the best next suggestion.",
      "Assess whether the previous suggestion is now addressed, ignored, irrelevant, or still active.",
      "Avoid generic suggestions like 'add tests' unless the current changes make that the most relevant next action.",
      "Set shouldNotify=false when there is no meaningful proactive message to show right now.",
      'Return JSON with keys: goal, focus, status, suggestionKey, suggestionText, relatedFiles, shouldNotify.',
    ];

    if (input.previousSummary) {
      sections.push(`Previous coding summary:\n${shield.sanitize(input.previousSummary)}`);
    }

    if (input.previousChatSummary) {
      sections.push(`Rolling chat memory:\n${shield.sanitize(input.previousChatSummary)}`);
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

    const { text } = await generateText({
      model: this.buildChatModel(),
      system: this.buildSummarySystemPrompt(),
      prompt,
      maxTokens: 420,
    });

    if (text.trim().length === 0) {
      throw new Error("Empty proactive insight returned from AI provider");
    }

    logger.aiResponse(text.length);
    return this.parseProactiveInsight(text);
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
    const timeoutMs = 45_000;
    const timeout = setTimeout(() => {
      abortController.abort(
        new Error(`AI provider timed out after ${Math.floor(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);

    const maxTokensByLevel: Record<MessageFrequencyLevel, number> = {
      1: 1200,
      2: 3000,
      3: 3600,
    };

    logger.aiRequest(
      input.messages.reduce((total, message) => total + message.content.length, 0),
    );

    try {
      await input.onStatus?.("Thinking...");

      const response = await generateText({
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
              logger.debug("AI", "Chat step finished", {
                finishReason: step.finishReason,
                toolCalls: step.toolCalls?.length ?? 0,
                toolResults: step.toolResults?.length ?? 0,
              });
            }
          : undefined,
      });

      const text = response.text;

      if (text.trim().length === 0) {
        throw new Error("Empty response returned from AI provider");
      }

      logger.aiResponse(text.length);
      return text;
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
      "Latest explicit user guidance overrides any inferred direction from file activity or prior summaries.",
      "If the user corrects the current direction, immediately pivot to the corrected goal and stop defending the previous inference.",
      "When codebase facts are needed, use tools to query project data instead of guessing.",
      "Do not edit files or run commands; provide advisory guidance only.",
      "Do not claim actions were executed unless explicitly in context.",
    ].join("\n");
  }

  private verbosityGuidance(kind: "chat" | "summary"): string {
    if (this.frequencyLevel === 1) {
      return kind === "chat"
        ? "Be concise: 1-3 sentences unless asked otherwise. High-signal only."
        : "Be concise: 1-2 sentences. No bullets.";
    }

    if (this.frequencyLevel === 3) {
      return kind === "chat"
        ? "Be comprehensive: explain reasoning, include brief structure (short bullets/sections are allowed), and provide concrete next steps."
        : "Be comprehensive: include more detail and concrete next steps. Short bullets are allowed.";
    }

    return kind === "chat"
      ? "Be standard: concise conversational flow; expand when it increases clarity."
      : "Be standard: concise but clear, with a concrete next step.";
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

  private buildChatMessages(input: {
    userMessage: string;
    recentMessages: ChatHistoryMessage[];
    previousSummary?: string;
    previousChatSummary?: string;
    workingMemory?: Record<string, string>;
    userIntent?: string;
    fallbackContext?: string;
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

    contextSections.push(
      "Project DB context is available via tools for code, events, and diffs. Use tools when facts are needed.",
    );

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
