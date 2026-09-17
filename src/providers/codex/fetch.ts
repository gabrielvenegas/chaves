import type { CodexCredential } from "./credentials.js";
import { ProviderAuthRequiredError } from "../types.js";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export interface CodexFetchAuth {
  getValidCredential(): Promise<CodexCredential>;
  forceRefresh(): Promise<CodexCredential>;
  markReauthRequired(): void;
}

export interface CreateCodexFetchOptions {
  auth: CodexFetchAuth;
  fetch?: typeof globalThis.fetch;
  sessionId: string;
  userAgent: string;
}

interface RequestSnapshot {
  method: string;
  headers: Headers;
  body?: ArrayBuffer;
  signal: AbortSignal;
}

export function createCodexFetch(
  options: CreateCodexFetchOptions,
): typeof globalThis.fetch {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : input;
    if (!shouldRewrite(new URL(requestUrl))) {
      return fetchImpl(input, init);
    }

    const sourceRequest = new Request(input, init);
    const snapshot = await snapshotRequest(sourceRequest);
    const credential = await options.auth.getValidCredential();
    let response = await fetchImpl(buildRequest(snapshot, credential, options));

    if (response.status !== 401) return response;

    const refreshedCredential = await options.auth.forceRefresh();
    response = await fetchImpl(
      buildRequest(snapshot, refreshedCredential, options),
    );
    if (response.status === 401) {
      options.auth.markReauthRequired();
      throw new ProviderAuthRequiredError(
        "Codex authorization has expired. Sign in again.",
      );
    }
    return response;
  };
}

function shouldRewrite(url: URL): boolean {
  return url.pathname.endsWith("/responses")
    || url.pathname.endsWith("/chat/completions");
}

async function snapshotRequest(request: Request): Promise<RequestSnapshot> {
  const rawBody = request.body === null
    ? undefined
    : await request.clone().arrayBuffer();
  return {
    method: request.method,
    headers: new Headers(request.headers),
    body: sanitizeJsonBody(rawBody, request.headers.get("content-type")),
    signal: request.signal,
  };
}

function sanitizeJsonBody(
  body: ArrayBuffer | undefined,
  contentType: string | null,
): ArrayBuffer | undefined {
  if (
    body === undefined
    || !contentType?.toLowerCase().includes("application/json")
  ) {
    return body;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return body;
    }
    const sanitized = { ...parsed } as Record<string, unknown>;
    delete sanitized.max_output_tokens;
    delete sanitized.temperature;
    delete sanitized.top_p;
    delete sanitized.top_logprobs;
    return new TextEncoder().encode(JSON.stringify(sanitized)).buffer;
  } catch {
    return body;
  }
}

function buildRequest(
  snapshot: RequestSnapshot,
  credential: CodexCredential,
  options: Pick<CreateCodexFetchOptions, "sessionId" | "userAgent">,
): Request {
  const headers = new Headers(snapshot.headers);
  headers.set("authorization", `Bearer ${credential.access}`);
  if (credential.accountId) {
    headers.set("ChatGPT-Account-Id", credential.accountId);
  } else {
    headers.delete("ChatGPT-Account-Id");
  }
  headers.set("originator", "chaves");
  headers.set("User-Agent", options.userAgent);
  headers.set("session-id", options.sessionId);

  return new Request(CODEX_API_ENDPOINT, {
    method: snapshot.method,
    headers,
    body: snapshot.body,
    signal: snapshot.signal,
  });
}
