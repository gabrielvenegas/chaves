import type { LanguageModelV1 } from "@ai-sdk/provider";

export type AiProviderId = "openrouter" | "codex";

export type ThinkingEffort = "low" | "medium" | "high";

export type ProviderAuthStatus =
  | { state: "ready"; expiresAt?: number }
  | { state: "configuration-required"; message: string }
  | { state: "reauth-required"; message: string };

export interface AiModelInfo {
  id: string;
  name: string;
  description?: string;
  contextLength?: number;
  inputPrice?: string;
  outputPrice?: string;
}

export interface AiProvider {
  readonly id: AiProviderId;
  readonly displayName: string;
  getAuthStatus(): Promise<ProviderAuthStatus>;
  getModel(modelId: string, thinkingEffort: ThinkingEffort): LanguageModelV1;
  listModels(): Promise<AiModelInfo[]>;
}

export class ProviderAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAuthRequiredError";
  }
}

export function isProviderAuthRequiredError(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof ProviderAuthRequiredError) return true;
    current = current.cause;
  }
  return false;
}
