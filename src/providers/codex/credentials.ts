import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";

export interface CodexCredential {
  access: string;
  refresh: string;
  expiresAt: number;
  accountId?: string;
}

export interface ResolveCodexCredentialPathOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

function isCodexCredential(value: unknown): value is CodexCredential {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.access === "string"
    && candidate.access.trim().length > 0
    && typeof candidate.refresh === "string"
    && candidate.refresh.trim().length > 0
    && typeof candidate.expiresAt === "number"
    && Number.isFinite(candidate.expiresAt)
    && (candidate.accountId === undefined || typeof candidate.accountId === "string");
}

export function resolveCodexCredentialPath(
  options: ResolveCodexCredentialPathOptions = {},
): string {
  const targetPlatform = options.platform ?? platform();
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;

  if (targetPlatform === "win32") {
    const appData = environment.APPDATA;
    const configDirectory = appData && path.win32.isAbsolute(appData)
      ? appData
      : path.win32.join(homeDirectory, "AppData", "Roaming");
    return path.win32.join(configDirectory, "chaves", "codex-auth.json");
  }

  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  const configDirectory = xdgConfigHome && path.posix.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : path.posix.join(homeDirectory, ".config");
  return path.posix.join(configDirectory, "chaves", "codex-auth.json");
}

export class CodexCredentialStore {
  constructor(
    private readonly credentialPath = resolveCodexCredentialPath(),
  ) {}

  async load(): Promise<CodexCredential | null> {
    let contents: string;
    try {
      contents = await readFile(this.credentialPath, "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(contents);
      if (!isCodexCredential(parsed)) return null;
      return {
        access: parsed.access,
        refresh: parsed.refresh,
        expiresAt: parsed.expiresAt,
        ...(parsed.accountId === undefined ? {} : { accountId: parsed.accountId }),
      };
    } catch {
      return null;
    }
  }

  async save(credential: CodexCredential): Promise<void> {
    if (!isCodexCredential(credential)) {
      throw new TypeError("Invalid Codex credential.");
    }

    const parentDirectory = path.dirname(this.credentialPath);
    await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
    await chmod(parentDirectory, 0o700);

    const temporaryPath = `${this.credentialPath}.${process.pid}.${randomUUID()}.tmp`;
    const serializedCredential: CodexCredential = {
      access: credential.access,
      refresh: credential.refresh,
      expiresAt: credential.expiresAt,
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    };
    let renamed = false;
    try {
      await writeFile(temporaryPath, JSON.stringify(serializedCredential), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.credentialPath);
      renamed = true;
      await chmod(this.credentialPath, 0o600);
    } finally {
      if (!renamed) {
        await rm(temporaryPath, { force: true });
      }
    }
  }

  async clear(): Promise<void> {
    try {
      await rm(this.credentialPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === code;
}
