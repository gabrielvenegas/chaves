import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { logger } from "./logger.js";
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

    logger.debug("AI", "✅ OpenRouter client initialized right now");
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

    const eventLog = events
      .map((e) => `[${e.timestamp}] ${e.event_type}: ${e.file_path}`)
      .join("\n");

    logger.debug("AI", "Event log:", eventLog);

    const prompt = this.buildEventSummaryPrompt(eventLog, previousSummary);

    logger.aiRequest(prompt.length);
    logger.debug("AI", `Prompt length: ${prompt.length} characters`);

    try {
      const startTime = Date.now();

      logger.debug("AI", `Calling generateText with model: ${this.model}`);

      const { text } = await generateText({
        model: this.client(this.model),
        maxTokens: 300,
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

  buildEventSummaryPrompt(eventLog: string, previousSummary?: string): string {
    const languageInstructions = this.getLanguageInstructions();

    return `LANGUAGE: You MUST respond in ${this.language === "pt" || this.language === "pt-BR" ? "português do Brasil" : this.language}. Do not use English or any other language.

You are Chaves, a coding companion. Analyze these recent IDE activity events and provide a concise, helpful summary of what the developer is working on.

${previousSummary ? `Previous context:\n${previousSummary}\n\n` : ""}
Recent activity:
${eventLog}

${languageInstructions}

Write a brief, conversational summary in 2–3 sentences. Mention the current focus and recent steps, then suggest a likely next step in natural language. If a meaningful clarification is needed, include one short question. Avoid bullet points and numbered lists. Keep it concise and actionable, but friendly.`;
  }

  buildDiffSummaryPrompt(
    diffSummary: string,
    previousSummary?: string,
  ): string {
    const languageInstructions = this.getLanguageInstructions();

    return `LANGUAGE: You MUST respond in ${this.language === "pt" || this.language === "pt-BR" ? "português do Brasil" : this.language}. Do not use English or any other language.

You are Chaves, a coding companion. Summarize the following file diffs and changes. Focus on intent, scope, and next steps.

${previousSummary ? `Previous context:\n${previousSummary}\n\n` : ""}${diffSummary}

${languageInstructions}

Write a brief, conversational summary in 2–3 sentences. Mention the current focus and recent steps, then suggest a likely next step in natural language. If a meaningful clarification is needed, include one short question. Avoid bullet points and numbered lists. Keep it concise and actionable, but friendly.`;
  }

  buildChatPrompt(userMessage: string, previousSummary?: string): string {
    const languageInstructions = this.getLanguageInstructions();

    return `LANGUAGE: You MUST respond in ${this.language === "pt" || this.language === "pt-BR" ? "português do Brasil" : this.language}. Do not use English or any other language.

You are Chaves, a coding companion. Respond to the user's message clearly and helpfully, using recent project context when it adds value.

${previousSummary ? `Previous context:\n${previousSummary}\n\n` : ""}User message:
${userMessage}

${languageInstructions}

Keep it concise and actionable. No fluff.`;
  }

  private getLanguageInstructions(): string {
    const instructions: Record<string, string> = {
      en: "Respond in English. Your entire response must be in English.",
      es: "Responde en español. Tu respuesta completa debe estar en español.",
      fr: "Répondez en français. Votre réponse complète doit être en français.",
      de: "Antworten Sie auf Deutsch. Ihre gesamte Antwort muss auf Deutsch sein.",
      it: "Rispondi in italiano. La tua risposta completa deve essere in italiano.",
      pt: "Responda em português do Brasil. Sua resposta completa deve estar em português do Brasil.",
      "pt-BR":
        "Responda em português do Brasil. Sua resposta completa deve estar em português do Brasil.",
      ru: "Ответьте на русском языке. Ваш ответ должен быть полностью на русском языке.",
      ja: "日本語で回答してください。あなたの回答は完全に日本語でなければなりません。",
      ko: "한국어로 답변해주세요。당신의 응답은 완전히 한국어로 이루어져야 합니다。",
      zh: "请用中文回答。您的回答必须完全用中文。",
    };

    return String(instructions[this.language] ?? instructions.en);
  }
}
