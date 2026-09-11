export type CodexTokenRefreshFailure = "invalid_grant" | "transient";

export class CodexTokenRefreshError extends Error {
  constructor(
    readonly failure: CodexTokenRefreshFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CodexTokenRefreshError";
  }

  get requiresReauthentication(): boolean {
    return this.failure === "invalid_grant";
  }
}
