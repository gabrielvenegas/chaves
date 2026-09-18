# Codex Subscription Authentication Design

## Goal

Allow Chaves users to choose between the existing OpenRouter API-key integration and ChatGPT-backed Codex subscription authentication, while keeping all AI workflows behind one provider boundary.

## Scope

- Preserve OpenRouter behavior and existing project configuration.
- Add browser-based ChatGPT OAuth using the same PKCE flow and Codex backend pattern used by OpenCode.
- Preserve two distinct flows: full onboarding for first-run configuration and a
  focused `--setup` maintenance menu for later changes.
- Share provider authentication and model-selection primitives between those
  flows without making `--setup` rerun the full onboarding.
- Refresh expiring Codex credentials automatically and stop repeated background failures when reauthentication is required.
- Make model construction and model discovery provider-aware.

## Non-goals

- Direct OpenAI API-key support.
- Claude subscription authentication.
- `/auth`, `/login`, or `/logout` slash commands.
- Device-code authentication in the first release.
- WebSocket transport in the first release.
- Copying OpenCode's full plugin system.

## Reference implementation

The Codex-specific behavior is adapted from OpenCode's `packages/opencode/src/plugin/openai/codex.ts`:

- OAuth Authorization Code flow with PKCE against `https://auth.openai.com`.
- Local callback at `http://localhost:1455/auth/callback`.
- Access/refresh token persistence and refresh serialization.
- Extraction of the ChatGPT account ID from token claims.
- A custom `fetch` that rewrites OpenAI Responses requests to `https://chatgpt.com/backend-api/codex/responses`.
- Codex-specific authorization, account, originator, user-agent, and session headers.

Chaves will port those mechanics into focused modules instead of copying OpenCode's plugin hooks, model registry, or WebSocket pool.

## Provider boundary

`Summarizer` must no longer construct an OpenRouter client or know how a provider authenticates. It receives an `AiProvider` and asks it for an AI SDK `LanguageModelV1`.

```ts
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
```

Authentication remains provider-internal. The application only reacts to typed provider status and errors.

### Module ownership

- `src/providers/types.ts` owns the provider-neutral contract and typed auth error.
- `src/providers/factory.ts` owns provider construction and creates the shared Codex auth manager.
- `src/providers/openrouter.ts` owns OpenRouter API-key status, AI SDK model construction, and catalog discovery through `@openrouter/ai-sdk-provider`.
- `src/providers/codex/credentials.ts`, `oauth.ts`, and `auth.ts` own global private storage, browser PKCE, refresh serialization, and reauthentication state.
- `src/providers/codex/fetch.ts` owns Codex endpoint rewriting, OAuth headers, and the one-refresh/one-retry `401` policy.
- `src/providers/codex/provider.ts` adapts `@ai-sdk/openai` Responses models and exposes the fixed Codex model catalog.

`Summarizer` depends only on `AiProvider`; it does not inspect credentials,
construct SDK clients, fetch catalogs, or branch on provider IDs.

## Project configuration

The per-project SQLite config gains `ai_provider` with values `openrouter` or `codex`. When absent, it resolves to `openrouter`, preserving every existing installation.

`summary_model` remains the selected model ID. Switching providers through setup requires choosing a model valid for the selected provider.

The existing `openrouter_api_key` remains per-project. Codex OAuth credentials must not be stored in `.chaves.db` because they belong to the user account, not one project.

## Codex credential storage

Codex credentials are stored as JSON under the user's configuration directory:

- `$XDG_CONFIG_HOME/chaves/codex-auth.json` when `XDG_CONFIG_HOME` exists.
- `%APPDATA%/chaves/codex-auth.json` on Windows.
- `~/.config/chaves/codex-auth.json` otherwise.

The directory is created with mode `0700`, the file with mode `0600`, and updates use a same-directory temporary file followed by rename.

```ts
export interface CodexCredential {
  access: string;
  refresh: string;
  expiresAt: number;
  accountId?: string;
}
```

Tokens are never logged or copied into error messages.

## OAuth flow

Setup creates a PKCE verifier/challenge and CSRF state, starts the localhost callback server, opens the authorization URL, validates the callback state, exchanges the code, extracts `accountId`, and persists the credential.

If the browser cannot be opened, setup prints the authorization URL and continues waiting. The callback waits for at most five minutes and always closes the server after success, failure, cancellation, or timeout.

Choosing `Sign in again` from setup starts browser sign-in for Codex, allowing
an expired session to recover or the user to switch accounts. Choosing
`Change AI provider or account` also authenticates the selected provider before
its model is selected.

## Auth lifecycle

Before each Codex request, the credential manager:

1. Loads the stored credential.
2. Returns it when the access token expires more than 60 seconds in the future.
3. Otherwise refreshes it and atomically persists the replacement.
4. Shares one in-flight refresh promise across concurrent callers.
5. Marks the provider `reauth-required` when refresh fails with an invalid/revoked grant.

If the Codex backend returns `401` despite a locally valid token, the transport forces one refresh and retries the request exactly once. A second `401` marks the provider `reauth-required`.

`403`, `429`, network errors, and `5xx` responses do not invalidate credentials. They remain provider/quota/transient errors.

## Codex transport

The Codex provider uses `@ai-sdk/openai` with its Responses model and an injected custom `fetch`. The custom fetch:

- Removes API-key authorization produced by the SDK.
- Adds the current OAuth Bearer token.
- Adds `ChatGPT-Account-Id` when available.
- Adds `originator: chaves`, a Chaves `User-Agent`, and the runtime `session-id`.
- Rewrites `/v1/responses` and `/chat/completions` to the Codex backend.
- Removes `max_output_tokens` from rewritten request bodies to match the Codex client behavior.
- Applies the single forced-refresh retry on `401`.

The first release uses HTTP streaming only.

The initial catalog is intentionally explicit and follows the current OpenCode
allowlist: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and
`gpt-5.3-codex-spark`. Updating that catalog is isolated to
`src/providers/codex/models.ts`.

## Onboarding, setup, and model selection

First-run onboarding remains the complete configuration experience. It asks for
provider/authentication, model, language, message frequency, personality, and
terminal capture. `chaves --onboarding` remains the explicit way to force that
full flow.

The onboarding begins with provider selection:

1. Sign in with ChatGPT — Codex subscription.
2. OpenRouter API key.

Codex selection runs OAuth and then displays only the Codex model catalog.
OpenRouter selection retains secret input and the OpenRouter catalog. Language,
frequency, personality, and terminal-capture sections remain unchanged.

`chaves --setup` remains a focused maintenance flow and starts with this menu:

1. Change model.
2. Change AI provider or account.
3. Sign in again.
4. Change language.
5. Other preferences.
6. Cancel.

Changing only the model lists models from the active provider and never touches
credentials. Changing provider authenticates the selected provider and requires
a compatible model selection before persisting both values. Signing in again
refreshes only the active provider's credentials and keeps the current model.
Other preferences edits message frequency, personality, and terminal capture.

The two flows call shared provider/authentication, model, language, and
preference section functions. They do not call each other. The TUI `/setup`
remains informational and points to `chaves --setup`.

No onboarding-version bump is required: existing version-2 projects default to OpenRouter and continue without interruption. Users opt into Codex by running setup.

## Runtime behavior when reauthentication is required

The provider exposes `reauth-required` and throws `ProviderAuthRequiredError`. Chaves recognizes that error even when wrapped by the AI SDK.

- Interactive chat displays one actionable error: `Your ChatGPT session expired. Run chaves --setup, choose Sign in again, then restart Chaves.`
- Background summaries, chat summaries, memory extraction, proactive insights, and debug diagnoses stop attempting AI calls while the provider is blocked. Pending debug incidents remain in a recoverable FIFO backed by SQLite across restarts.
- File watching, indexing, history, diffs, and the TUI continue working.
- The notice is deduplicated for the process lifetime.
