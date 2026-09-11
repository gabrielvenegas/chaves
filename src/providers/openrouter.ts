import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type {
  AiModelInfo,
  AiProvider,
  ProviderAuthStatus,
  ThinkingEffort,
} from "./types.js";

interface OpenRouterClient {
  chat(
    modelId: string,
    settings: { reasoning: { effort: ThinkingEffort } },
  ): ReturnType<ReturnType<typeof createOpenRouter>["chat"]>;
}

export interface OpenRouterProviderOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  client?: OpenRouterClient;
}

export class OpenRouterProvider implements AiProvider {
  readonly id = "openrouter" as const;
  readonly displayName = "OpenRouter";
  private readonly client: OpenRouterClient;

  constructor(private readonly options: OpenRouterProviderOptions) {
    this.client = options.client ?? createOpenRouter({ apiKey: options.apiKey });
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    return this.options.apiKey.trim()
      ? { state: "ready" }
      : {
          state: "configuration-required",
          message: "OpenRouter API key is not configured. Run chaves --setup.",
        };
  }

  getModel(modelId: string, thinkingEffort: ThinkingEffort) {
    return this.client.chat(modelId, {
      reasoning: { effort: thinkingEffort },
    });
  }

  async listModels(): Promise<AiModelInfo[]> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to list OpenRouter models (${response.status}).`);
    }
    const payload = await response.json() as {
      data: Array<{
        id: string;
        name?: string;
        description?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };
    return payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      ...(model.description === undefined
        ? {}
        : { description: model.description }),
      contextLength: model.context_length,
      inputPrice: model.pricing?.prompt,
      outputPrice: model.pricing?.completion,
    }));
  }
}
