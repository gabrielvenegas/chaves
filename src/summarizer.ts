import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { logger } from "./logger.js";
import { shield } from "./shield.js";
import type { ActivityEvent } from "./store.js";

export class Summarizer {
  private client: ReturnType<typeof createOpenAI>;
  private model: string;
  private language: string;

  constructor(
    model: string = "anthropic/claude-3.5-haiku",
    language: string = "en",
  ) {
    this.model = model;
    this.language = language;

    logger.debug("AI", "Initializing OpenRouter client");
    this.client = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    logger.debug("AI", "✅ OpenRouter client initialized");
    logger.debug("AI", `Using model: ${this.model}`);
    logger.debug("AI", `Using language: ${this.language}`);

    if (!process.env.OPENROUTER_API_KEY) {
      logger.warn(
        "AI",
        "⚠️  OPENROUTER_API_KEY not set - AI features will fail",
      );
    } else {
      logger.debug("AI", "OPENROUTER_API_KEY found in environment");
    }
  }

  async generateSummary(
    events: ActivityEvent[],
    previousSummary?: string,
  ): Promise<string> {
    logger.debug("AI", `🤖 Generating summary for ${events.length} events`);

    const eventCounts = events
      .map((e) => {
        const path = e.file_path ?? "";
        const base = path.split("/").pop() ?? path;
        return `${e.event_type}:${base}`;
      })
      .reduce<Record<string, number>>((acc, key) => {
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});

    const eventLog = Object.entries(eventCounts)
      .map(([key, count]) => (count > 1 ? `${key}x${count}` : key))
      .join(";");

    logger.debug("AI", "Event log:", eventLog);

    const system = this.buildSystemPrompt();
    const prompt = shield.sanitize(
      this.buildEventSummaryPrompt(eventLog, previousSummary),
    );

    logger.aiRequest(prompt.length);
    logger.debug("AI", `Prompt length: ${prompt.length} characters`);

    try {
      const startTime = Date.now();
      logger.debug("AI", `Calling generateText with model: ${this.model}`);

      const { text } = await generateText({
        model: this.client(this.model),
        maxTokens: 200,
        system,
        prompt,
      });

      const duration = Date.now() - startTime;
      logger.aiResponse(text.length);
      logger.debug("AI", `⏱️  Request completed in ${duration}ms`);
      logger.debug("AI", "Generated summary:", text);

      if (text.trim().length === 0) {
        throw new Error("Empty summary returned from AI provider");
      }

      return text;
    } catch (error) {
      logger.aiError(error);

      if (error instanceof Error) {
        logger.error("AI", `Error message: ${error.message}`);
        logger.error("AI", `Error stack:`, error.stack);
      }

      throw error;
    }
  }

  private buildSystemPrompt(): string {
    const lang =
      this.language === "pt" || this.language === "pt-BR"
        ? "português do Brasil"
        : this.language;

    return `You are Chaves, a coding companion working alongside the user.
Respond in ${lang} only. No other language.
Be concise (1–2 sentences unless asked otherwise). Speak directly using "you" and "we".
Professional, helpful tone. No greetings, filler, bullet points, or numbered lists.
Prefer statements over questions unless genuinely necessary.`;
  }

  buildEventSummaryPrompt(eventLog: string, previousSummary?: string): string {
    const parts: string[] = [];

    if (previousSummary) {
      parts.push(`Previous context:\n${shield.sanitize(previousSummary)}`);
    }

    parts.push(
      `Recent IDE activity:\n${eventLog}\n\nSummarize current focus, most recent step, and likely next step.`,
    );

    return parts.join("\n\n");
  }

  buildDiffSummaryPrompt(
    diffSummary: string,
    previousSummary?: string,
  ): string {
    const parts: string[] = [];

    if (previousSummary) {
      parts.push(`Previous context:\n${shield.sanitize(previousSummary)}`);
    }

    parts.push(
      `File diffs:\n${shield.sanitize(diffSummary)}\n\nSummarize intent, scope, and next steps.`,
    );

    return parts.join("\n\n");
  }

  buildChatPrompt(userMessage: string, previousSummary?: string): string {
    const parts: string[] = [];

    if (previousSummary) {
      parts.push(`Previous context:\n${shield.sanitize(previousSummary)}`);
    }

    parts.push(`User message:\n${shield.sanitize(userMessage)}`);

    return parts.join("\n\n");
  }

  async generateDiff(
    diffSummary: string,
    previousSummary?: string,
  ): Promise<string> {
    const system = this.buildSystemPrompt();
    const prompt = this.buildDiffSummaryPrompt(diffSummary, previousSummary);

    logger.aiRequest(prompt.length);

    const { text } = await generateText({
      model: this.client(this.model),
      maxTokens: 300,
      system,
      prompt,
    });

    if (text.trim().length === 0) {
      throw new Error("Empty summary returned from AI provider");
    }

    logger.aiResponse(text.length);
    return text;
  }

  async generateChat(
    userMessage: string,
    previousSummary?: string,
  ): Promise<string> {
    const system = this.buildSystemPrompt();
    const prompt = this.buildChatPrompt(userMessage, previousSummary);

    logger.aiRequest(prompt.length);

    const { text } = await generateText({
      model: this.client(this.model),
      maxTokens: 3000,
      system,
      prompt,
    });

    if (text.trim().length === 0) {
      throw new Error("Empty response returned from AI provider");
    }

    logger.aiResponse(text.length);
    return text;
  }
}
