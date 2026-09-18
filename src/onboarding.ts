import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { createInterface } from "readline/promises";
import { fileURLToPath } from "url";
import chalk from "chalk";
import {
  authenticateProviderSection,
  editPreferencesSection,
  selectLanguageSection,
  selectModelSection,
  selectProviderSection,
  type ConfigurationPersonality,
  type ConfigurationReadline,
  type FrequencyLevel,
} from "./configurationSections.js";
import type { CodexAuthManager } from "./providers/codex/auth.js";
import {
  createAiProvider,
  createCodexAuthManager,
  type CreateAiProviderInput,
} from "./providers/factory.js";
import type { AiProvider } from "./providers/types.js";
import type { Store } from "./store.js";

export const CURRENT_ONBOARDING_VERSION = "2";
const ASCII_BANNER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../chaves-ascii",
);

const theme = {
  accent: chalk.hex("#f4bc69"),
  accentStrong: chalk.hex("#ff9b3d"),
  text: chalk.hex("#f2dfc3"),
  muted: chalk.hex("#ab9784"),
  border: chalk.hex("#5a4a3d"),
  success: chalk.hex("#c8d35a"),
};

export type OnboardingResult = "completed" | "skipped" | "aborted";

export interface OnboardingDependencies {
  rl?: ConfigurationReadline;
  isInteractive?: () => boolean;
  codexAuthManager?: CodexAuthManager;
  createProvider?: (input: CreateAiProviderInput) => AiProvider;
  sessionId?: string;
  userAgent?: string;
}

function renderRule(label?: string): string {
  const width = Math.max(36, Math.min(process.stdout.columns ?? 80, 88));
  if (!label) return theme.border("─".repeat(width));
  const title = ` ${label.toUpperCase()} `;
  const remaining = Math.max(0, width - title.length);
  const left = Math.floor(remaining / 2);
  return `${theme.border("─".repeat(left))}${theme.accent(title)}${theme.border("─".repeat(remaining - left))}`;
}

function printSection(title: string, description?: string): void {
  console.log("");
  console.log(renderRule(title));
  if (description) console.log(theme.muted(description));
  console.log("");
}

function printSummaryLine(label: string, value: string): void {
  console.log(`${theme.success("✓")} ${theme.text(label)} ${theme.muted("•")} ${value}`);
}

function printBanner(projectPath: string): void {
  console.log("");
  try {
    const banner = readFileSync(ASCII_BANNER_PATH, "utf8")
      .trimEnd()
      .split("\n")
      .map((line, index) =>
        index % 2 === 0 ? theme.accent(line) : theme.accentStrong(line)
      )
      .join("\n");
    console.log(banner);
  } catch {
    console.log(theme.accentStrong.bold("CHAVES"));
  }
  console.log(theme.text("Project setup wizard"));
  console.log(theme.muted(`Project: ${projectPath}`));
  console.log(
    theme.muted(
      "Choose how Chaves should connect, communicate, and observe this project.",
    ),
  );
  console.log(renderRule());
}

function needsOnboarding(store: Store): boolean {
  return store.getConfig("onboarding_completed") !== "true"
    || store.getConfig("onboarding_version") !== CURRENT_ONBOARDING_VERSION;
}

export async function runOnboardingIfNeeded(
  input: { projectPath: string; store: Store; force: boolean },
  dependencies: OnboardingDependencies = {},
): Promise<OnboardingResult> {
  if (!input.force && !needsOnboarding(input.store)) return "skipped";

  const isInteractive = dependencies.isInteractive ?? (() => Boolean(process.stdin.isTTY));
  if (!isInteractive()) {
    console.log(
      [
        "Chaves onboarding requires an interactive terminal.",
        "Run again in a TTY, or run:",
        `  bun run setup ${input.projectPath}`,
      ].join("\n"),
    );
    return "aborted";
  }

  const ownsReadline = !dependencies.rl;
  const rl = dependencies.rl
    ?? createInterface({ input: process.stdin, output: process.stdout });
  const authManager = dependencies.codexAuthManager ?? createCodexAuthManager();
  const providerFactory = dependencies.createProvider ?? createAiProvider;
  const sessionId = dependencies.sessionId ?? randomUUID();
  const userAgent = dependencies.userAgent ?? "chaves/setup";

  try {
    const existingApiKey = input.store.getConfig("openrouter_api_key")?.trim() ?? "";
    const existingModel = input.store.getModel();
    const existingLanguage = input.store.getLanguage();
    const existingPreferences = {
      frequencyLevel: input.store.getConfigEnum(
        "message_frequency_level",
        ["1", "2", "3"] as const,
        "2",
      ) as FrequencyLevel,
      personality: input.store.getConfigEnum(
        "personality",
        ["technical", "collaborative", "creative"] as const,
        "collaborative",
      ) as ConfigurationPersonality,
      devCommand: input.store.getConfig("dev_command")?.trim() ?? "",
    };

    printBanner(input.projectPath);
    printSection("AI provider", "Choose how Chaves should access an AI model.");
    const providerId = await selectProviderSection(rl, {
      currentProvider: input.store.getAiProvider(),
      cancelLabel: "Cancel onboarding",
    });
    if (!providerId) return "aborted";

    const auth = await authenticateProviderSection(rl, {
      providerId,
      currentOpenRouterApiKey: existingApiKey,
      loginCodex: async () => {
        await authManager.login();
      },
    });
    if (!auth) return "aborted";

    const provider = providerId === "openrouter"
      ? providerFactory({
          providerId,
          apiKey: auth.openRouterApiKey ?? existingApiKey,
        })
      : providerFactory({
          providerId,
          auth: authManager,
          sessionId,
          userAgent,
        });

    printSection(
      "Model",
      "Pick the model Chaves should use for summaries and chat analysis.",
    );
    const model = await selectModelSection(rl, {
      provider,
      currentModelId: existingModel,
    });
    if (!model) return "aborted";

    printSection(
      "Language",
      "Choose the language Chaves should use in its responses.",
    );
    const language = await selectLanguageSection(rl, existingLanguage);
    if (!language) return "aborted";

    printSection(
      "Preferences",
      "Choose message frequency, personality, and terminal capture.",
    );
    const preferences = await editPreferencesSection(rl, existingPreferences, {
      cancelLabel: "Cancel onboarding",
    });
    if (!preferences) return "aborted";

    input.store.setAiProvider(providerId);
    if (auth.openRouterApiKey != null) {
      input.store.setConfig("openrouter_api_key", auth.openRouterApiKey);
    }
    input.store.setModel(model);
    input.store.setLanguage(language);
    input.store.setConfig("message_frequency_level", preferences.frequencyLevel);
    input.store.setConfig("personality", preferences.personality);
    input.store.setConfig("dev_command", preferences.devCommand);
    input.store.setConfig("onboarding_completed", "true");
    input.store.setConfig("onboarding_version", CURRENT_ONBOARDING_VERSION);
    input.store.setConfig("onboarding_completed_at", new Date().toISOString());

    printSection("Summary", "Saved settings for this project.");
    printSummaryLine(
      "AI provider",
      theme.text(providerId === "codex" ? "ChatGPT / Codex" : "OpenRouter"),
    );
    printSummaryLine("Model", theme.text(model));
    printSummaryLine("Language", theme.text(language));
    printSummaryLine("Message frequency", theme.text(preferences.frequencyLevel));
    printSummaryLine("Personality", theme.text(preferences.personality));
    printSummaryLine(
      "Terminal capture",
      preferences.devCommand
        ? theme.text(preferences.devCommand)
        : theme.muted("Not configured"),
    );
    console.log("");
    console.log(theme.success("Onboarding complete."));
    console.log("");
    return "completed";
  } finally {
    if (ownsReadline) rl.close();
  }
}
