import { CodexAuthManager } from "./codex/auth.js";
import { CodexCredentialStore } from "./codex/credentials.js";
import { CodexOAuthClient } from "./codex/oauth.js";
import { CodexProvider } from "./codex/provider.js";
import { OpenRouterProvider } from "./openrouter.js";
import type { AiProvider } from "./types.js";

export type CreateAiProviderInput =
  | {
      providerId: "openrouter";
      apiKey: string;
    }
  | {
      providerId: "codex";
      auth: CodexAuthManager;
      sessionId: string;
      userAgent: string;
    };

export function createCodexAuthManager(
  credentialStore = new CodexCredentialStore(),
): CodexAuthManager {
  return new CodexAuthManager({
    store: credentialStore,
    oauth: new CodexOAuthClient(),
  });
}

export function createAiProvider(input: CreateAiProviderInput): AiProvider {
  if (input.providerId === "openrouter") {
    return new OpenRouterProvider({ apiKey: input.apiKey });
  }
  return new CodexProvider({
    auth: input.auth,
    sessionId: input.sessionId,
    userAgent: input.userAgent,
  });
}
