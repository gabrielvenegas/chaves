import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import type { CodexAuthManager } from "./auth.js";
import { createCodexFetch } from "./fetch.js";
import { CODEX_MODELS } from "./models.js";
import type {
  AiProvider,
  ProviderAuthStatus,
  ThinkingEffort,
} from "../types.js";

export interface CodexProviderOptions {
  auth: CodexAuthManager;
  fetch?: typeof globalThis.fetch;
  sessionId: string;
  userAgent: string;
}

export class CodexProvider implements AiProvider {
  readonly id = "codex" as const;
  readonly displayName = "Codex subscription";
  private readonly openai: ReturnType<typeof createOpenAI>;

  constructor(private readonly options: CodexProviderOptions) {
    this.openai = createOpenAI({
      apiKey: "codex-oauth",
      fetch: createCodexFetch({
        auth: options.auth,
        fetch: options.fetch,
        sessionId: options.sessionId,
        userAgent: options.userAgent,
      }),
    });
  }

  getAuthStatus(): Promise<ProviderAuthStatus> {
    return this.options.auth.getStatus();
  }

  getModel(modelId: string, thinkingEffort: ThinkingEffort) {
    return wrapLanguageModel({
      model: this.openai.responses(modelId),
      middleware: defaultSettingsMiddleware({
        settings: {
          providerMetadata: {
            openai: {
              reasoningEffort: thinkingEffort,
              store: false,
              strictSchemas: false,
            },
          },
        },
      }),
    });
  }

  async listModels() {
    return CODEX_MODELS.map((model) => ({ ...model }));
  }
}
