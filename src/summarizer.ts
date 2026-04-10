import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { logger } from "./logger.js";
import { shield } from "./shield.js";
import type { ActivityEvent, StoredMessage } from "./store.js";

type ChatRole = "user" | "assistant" | "system";

export type MessageFrequencyLevel = 1 | 2 | 3;
export type Personality = "technical" | "collaborative" | "creative";

export interface ChatHistoryMessage {
  role: ChatRole;
  content: string;
}

interface GenerateChatInput {
  userMessage: string;
  previousSummary?: string;
  previousChatSummary?: string;
  userIntent?: string;
  recentMessages?: ChatHistoryMessage[];
  tools?: Record<string, unknown>;
  fallbackContext?: string;
}

export interface SummarizerOptions {
  model?: string;
  language?: string;
  apiKey?: string;
  frequencyLevel?: MessageFrequencyLevel;
  personality?: Personality;
}

export class Summarizer {
  private client: ReturnType<typeof createOpenAI>;
  private model: string;
  private language: string;
  private apiKey?: string;
  private frequencyLevel: MessageFrequencyLevel;
  private personality: Personality;

  constructor(options: SummarizerOptions = {}) {
    this.model = options.model ?? "anthropic/claude-3.5-haiku";
    this.language = options.language ?? "en";
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.frequencyLevel = options.frequencyLevel ?? 2;
    this.personality = options.personality ?? "collaborative";

    logger.debug("AI", "Initializing OpenRouter client");
    this.client = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: this.apiKey,
    });
    logger.debug("AI", "OpenRouter client initialized");
    logger.debug("AI", `Using model: ${this.model}`);
    logger.debug("AI", `Using language: ${this.language}`);

    if (!this.apiKey) {
      logger.warn("AI", "OPENROUTER_API_KEY not set - AI features will fail");
    }
  }

  async generateSummary(
    events: ActivityEvent[],
    previousSummary?: string,
    userIntent?: string,
  ): Promise<string> {
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
        model: this.client(this.model),
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
      model: this.client(this.model),
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
    const system = this.buildChatSystemPrompt();
    const messages = this.buildChatMessages({
      userMessage: input.userMessage,
      recentMessages: input.recentMessages ?? [],
      previousSummary: input.previousSummary,
      previousChatSummary: input.previousChatSummary,
      userIntent: input.userIntent,
    });

    try {
      return await this.generateChatCompletion({
        system,
        messages,
        tools: input.tools,
      });
    } catch (error) {
      if (!input.tools) throw error;

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
      });
    }
  }

  async generateChatSummary(
    messages: StoredMessage[],
    previousChatSummary?: string,
  ): Promise<string> {
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
      model: this.client(this.model),
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

  private async generateChatCompletion(input: {
    system: string;
    messages: Array<{ role: ChatRole; content: string }>;
    tools?: Record<string, unknown>;
  }): Promise<string> {
    const toolEnabled = Boolean(input.tools);

    const maxTokensByLevel: Record<MessageFrequencyLevel, number> = {
      1: 1200,
      2: 3000,
      3: 3600,
    };

    const response = await generateText({
      model: this.client(this.model),
      system: input.system,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: shield.sanitize(message.content),
      })),
      tools: input.tools as any,
      toolChoice: toolEnabled ? "auto" : undefined,
      maxSteps: toolEnabled ? 5 : undefined,
      maxTokens: maxTokensByLevel[this.frequencyLevel],
      onStepFinish: toolEnabled
        ? (step) => {
            logger.debug("AI", "Chat step finished", {
              finishReason: step.finishReason,
              toolCalls: step.toolCalls?.length ?? 0,
              toolResults: step.toolResults?.length ?? 0,
            });
          }
        : undefined,
    });

    if (response.text.trim().length === 0) {
      throw new Error("Empty response returned from AI provider");
    }

    logger.aiResponse(response.text.length);
    return response.text;
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

  private buildChatMessages(input: {
    userMessage: string;
    recentMessages: ChatHistoryMessage[];
    previousSummary?: string;
    previousChatSummary?: string;
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
