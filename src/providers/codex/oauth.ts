import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import open from "open";
import type { CodexCredential } from "./credentials.js";
import { CodexTokenRefreshError } from "./errors.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

// Browser OAuth mechanics adapted from OpenCode's MIT-licensed reference:
// https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/codex.ts

export interface CodexTokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface CodexTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id?: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

export interface CodexOAuthCallbackResponse {
  status: number;
  body: string;
}

export type CodexOAuthCallbackHandler = (
  url: URL,
) => Promise<CodexOAuthCallbackResponse> | CodexOAuthCallbackResponse;

export interface CodexOAuthCallbackServer {
  listen(handler: CodexOAuthCallbackHandler): Promise<void>;
  close(): Promise<void>;
}

export interface CodexOAuthClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CodexOAuthClientOptions {
  fetch?: typeof globalThis.fetch;
  openBrowser?: (url: string) => Promise<unknown>;
  clock?: CodexOAuthClock;
  randomBytes?: (size: number) => Uint8Array;
  createCallbackServer?: () => CodexOAuthCallbackServer;
  writeOutput?: (message: string) => void;
}

const systemClock: CodexOAuthClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CodexOAuthClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly openBrowser: (url: string) => Promise<unknown>;
  private readonly clock: CodexOAuthClock;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly createCallbackServer: () => CodexOAuthCallbackServer;
  private readonly writeOutput: (message: string) => void;

  constructor(options: CodexOAuthClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.openBrowser = options.openBrowser ?? ((url) => open(url));
    this.clock = options.clock ?? systemClock;
    this.randomBytes = options.randomBytes ?? ((size) => nodeRandomBytes(size));
    this.createCallbackServer = options.createCallbackServer
      ?? (() => new NodeCodexOAuthCallbackServer());
    this.writeOutput = options.writeOutput ?? ((message) => console.error(message));
  }

  async login(): Promise<CodexCredential> {
    const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
    const verifier = base64UrlEncode(this.randomBytes(32));
    const challenge = base64UrlEncode(
      createHash("sha256").update(verifier).digest(),
    );
    const state = base64UrlEncode(this.randomBytes(32));
    const authorizationUrl = buildAuthorizationUrl(
      redirectUri,
      challenge,
      state,
    );
    const server = this.createCallbackServer();
    let timeoutHandle: unknown;
    let settled = false;
    let resolveCallback!: (code: string) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<string>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });

    const settleWithCode = (code: string): void => {
      if (settled) return;
      settled = true;
      resolveCallback(code);
    };
    const settleWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectCallback(error);
    };

    try {
      await server.listen((url) => {
        if (url.pathname !== CALLBACK_PATH) {
          return { status: 404, body: "Not found" };
        }
        if (url.searchParams.get("state") !== state) {
          settleWithError(new Error("Invalid OAuth state."));
          return { status: 400, body: "Authorization failed." };
        }
        const oauthError = url.searchParams.get("error");
        if (oauthError) {
          settleWithError(new Error("Authorization was rejected."));
          return { status: 400, body: "Authorization failed." };
        }
        const code = url.searchParams.get("code");
        if (!code) {
          settleWithError(new Error("Authorization code is missing."));
          return { status: 400, body: "Authorization failed." };
        }
        settleWithCode(code);
        return {
          status: 200,
          body: "Authorization complete. You can return to Chaves.",
        };
      });

      timeoutHandle = this.clock.setTimeout(() => {
        settleWithError(new Error("OAuth callback timed out."));
      }, CALLBACK_TIMEOUT_MS);

      void Promise.resolve()
        .then(() => this.openBrowser(authorizationUrl))
        .catch(() => {
          this.writeOutput(`Open this URL to continue: ${authorizationUrl}`);
        });

      const code = await callback;
      const tokens = await this.exchangeCode(code, redirectUri, verifier);
      return credentialFromLoginTokens(tokens, this.clock.now());
    } finally {
      if (timeoutHandle !== undefined) this.clock.clearTimeout(timeoutHandle);
      await server.close();
    }
  }

  async refresh(credential: CodexCredential): Promise<CodexCredential> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credential.refresh,
          client_id: CLIENT_ID,
        }).toString(),
      });
    } catch {
      throw new CodexTokenRefreshError(
        "transient",
        "Token refresh failed due to a network error.",
      );
    }

    if (!response.ok) {
      const failure = await classifyRefreshFailure(response);
      throw new CodexTokenRefreshError(
        failure,
        `Token refresh failed (${response.status}).`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CodexTokenRefreshError(
        "transient",
        "Token refresh returned an invalid response.",
      );
    }
    if (!isTokenResponse(payload)) {
      throw new CodexTokenRefreshError(
        "transient",
        "Token refresh returned an invalid response.",
      );
    }

    const access = nonEmptyString(payload.access_token);
    const refresh = payload.refresh_token === undefined
      ? credential.refresh
      : nonEmptyString(payload.refresh_token);
    const expiresIn = validExpiresIn(payload.expires_in);
    const expiresAt = expiresIn === undefined
      ? undefined
      : computeExpiresAt(this.clock.now(), expiresIn);
    if (!access || !refresh || expiresAt === undefined) {
      throw new CodexTokenRefreshError(
        "transient",
        "Token refresh returned an invalid response.",
      );
    }
    const accountId = extractAccountId(payload) ?? credential.accountId;
    return {
      access,
      refresh,
      expiresAt,
      ...(accountId ? { accountId } : {}),
    };
  }

  private async exchangeCode(
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<CodexTokenResponse> {
    const response = await this.fetchImpl(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`Token exchange failed (${response.status}).`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Token exchange returned an invalid response.");
    }
    if (!isTokenResponse(payload)) {
      throw new Error("Token exchange returned an invalid response.");
    }
    return payload;
  }
}

export function extractAccountId(
  tokens: Pick<CodexTokenResponse, "access_token" | "id_token">,
): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    if (!claims) continue;
    const accountId = nonEmptyString(claims.chatgpt_account_id)
      ?? nonEmptyString(
        claims["https://api.openai.com/auth"]?.chatgpt_account_id,
      )
      ?? nonEmptyString(claims.organizations?.[0]?.id);
    if (accountId) return accountId;
  }
  return undefined;
}

function buildAuthorizationUrl(
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "chaves",
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

function credentialFromLoginTokens(
  tokens: CodexTokenResponse,
  now: number,
): CodexCredential {
  const access = nonEmptyString(tokens.access_token);
  const refresh = nonEmptyString(tokens.refresh_token);
  if (!access || !refresh) {
    throw new Error("Token exchange returned an invalid response.");
  }
  const expiresIn = validExpiresIn(tokens.expires_in);
  const expiresAt = expiresIn === undefined
    ? undefined
    : computeExpiresAt(now, expiresIn);
  if (expiresAt === undefined) {
    throw new Error("Token exchange returned an invalid response.");
  }
  const accountId = extractAccountId(tokens);
  return {
    access,
    refresh,
    expiresAt,
    ...(accountId ? { accountId } : {}),
  };
}

function isTokenResponse(value: unknown): value is CodexTokenResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.access_token === "string"
    && (candidate.id_token === undefined || typeof candidate.id_token === "string")
    && (candidate.refresh_token === undefined
      || typeof candidate.refresh_token === "string")
    && validExpiresIn(candidate.expires_in) !== undefined;
}

function validExpiresIn(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_EXPIRES_IN_SECONDS;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function computeExpiresAt(now: number, expiresIn: number): number | undefined {
  const expiresAt = now + expiresIn * 1000;
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

function parseJwtClaims(token: string): CodexTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return typeof parsed === "object" && parsed !== null
      ? parsed as CodexTokenClaims
      : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function classifyRefreshFailure(
  response: Response,
): Promise<"invalid_grant" | "transient"> {
  if (response.status !== 400) return "transient";
  try {
    const payload: unknown = await response.json();
    return typeof payload === "object"
      && payload !== null
      && (payload as Record<string, unknown>).error === "invalid_grant"
      ? "invalid_grant"
      : "transient";
  } catch {
    return "transient";
  }
}

class NodeCodexOAuthCallbackServer implements CodexOAuthCallbackServer {
  private server: Server | undefined;

  async listen(handler: CodexOAuthCallbackHandler): Promise<void> {
    const server = createServer((request, response) => {
      const url = new URL(
        request.url ?? "/",
        `http://localhost:${CALLBACK_PORT}`,
      );
      Promise.resolve(handler(url)).then((result) => {
        response.writeHead(result.status, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(result.body);
      }).catch(() => {
        response.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Authorization failed.");
      });
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(CALLBACK_PORT, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
