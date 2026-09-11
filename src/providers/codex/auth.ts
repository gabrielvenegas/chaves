import type {
  CodexCredential,
  CodexCredentialStore,
} from "./credentials.js";
import { CodexTokenRefreshError } from "./errors.js";
import type { CodexOAuthClient } from "./oauth.js";
import {
  ProviderAuthRequiredError,
  type ProviderAuthStatus,
} from "../types.js";

const REFRESH_SKEW_MS = 60_000;
const CONFIGURATION_REQUIRED_MESSAGE =
  "Codex is not configured. Sign in to continue.";
const REAUTH_REQUIRED_MESSAGE =
  "Codex authorization has expired. Sign in again.";

interface CodexAuthStore {
  load(): ReturnType<CodexCredentialStore["load"]>;
  save(credential: CodexCredential): ReturnType<CodexCredentialStore["save"]>;
}

interface CodexAuthOAuthClient {
  login(): ReturnType<CodexOAuthClient["login"]>;
  refresh(credential: CodexCredential): ReturnType<CodexOAuthClient["refresh"]>;
}

export interface CodexAuthManagerOptions {
  store: CodexAuthStore;
  oauth: CodexAuthOAuthClient;
  now?: () => number;
}

export class CodexAuthManager {
  private refreshPromise: Promise<CodexCredential> | undefined;
  private reauthRequired = false;
  private readonly now: () => number;

  constructor(private readonly options: CodexAuthManagerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async getValidCredential(): Promise<CodexCredential> {
    const credential = await this.requireCredential();
    if (credential.expiresAt > this.now() + REFRESH_SKEW_MS) {
      return credential;
    }
    return this.refresh(credential);
  }

  async forceRefresh(): Promise<CodexCredential> {
    return this.refresh(await this.requireCredential());
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    if (this.reauthRequired) {
      return {
        state: "reauth-required",
        message: REAUTH_REQUIRED_MESSAGE,
      };
    }
    const credential = await this.options.store.load();
    if (!credential) {
      return {
        state: "configuration-required",
        message: CONFIGURATION_REQUIRED_MESSAGE,
      };
    }
    return { state: "ready", expiresAt: credential.expiresAt };
  }

  async login(): Promise<CodexCredential> {
    const credential = await this.options.oauth.login();
    await this.options.store.save(credential);
    this.reauthRequired = false;
    return credential;
  }

  markReauthRequired(): void {
    this.reauthRequired = true;
  }

  private async requireCredential(): Promise<CodexCredential> {
    if (this.reauthRequired) {
      throw new ProviderAuthRequiredError(REAUTH_REQUIRED_MESSAGE);
    }
    const credential = await this.options.store.load();
    if (!credential) {
      throw new ProviderAuthRequiredError(CONFIGURATION_REQUIRED_MESSAGE);
    }
    return credential;
  }

  private async refresh(
    credential: CodexCredential,
  ): Promise<CodexCredential> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.performRefresh(credential);
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async performRefresh(
    credential: CodexCredential,
  ): Promise<CodexCredential> {
    try {
      const refreshed = await this.options.oauth.refresh(credential);
      await this.options.store.save(refreshed);
      return refreshed;
    } catch (error) {
      if (
        error instanceof CodexTokenRefreshError
        && error.requiresReauthentication
      ) {
        this.markReauthRequired();
        throw new ProviderAuthRequiredError(REAUTH_REQUIRED_MESSAGE);
      }
      throw error;
    }
  }
}
