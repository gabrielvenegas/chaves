import type { createInterface } from "readline/promises";
import chalk from "chalk";
import { ModelSetup } from "./modelSetup.js";
import type { AiProvider, AiProviderId } from "./providers/types.js";

export type ConfigurationReadline = ReturnType<typeof createInterface>;
export type FrequencyLevel = "1" | "2" | "3";
export type ConfigurationPersonality =
  | "technical"
  | "collaborative"
  | "creative";

export interface ProviderAuthResult {
  providerId: AiProviderId;
  openRouterApiKey?: string;
}

export interface PreferencesResult {
  frequencyLevel: FrequencyLevel;
  personality: ConfigurationPersonality;
  devCommand: string;
}

const theme = {
  accent: chalk.hex("#f4bc69"),
  text: chalk.hex("#f2dfc3"),
  muted: chalk.hex("#ab9784"),
  success: chalk.hex("#c8d35a"),
  warning: chalk.hex("#f6ad55"),
  danger: chalk.hex("#f56565"),
};

function printOption(
  index: number,
  title: string,
  description: string,
  options: { isCurrent?: boolean } = {},
): void {
  const suffix = options.isCurrent ? theme.muted(" [current]") : "";
  console.log(`${theme.accent(`${index}.`)} ${theme.text(title)}${suffix}`);
  console.log(`   ${theme.muted(description)}`);
}

async function promptChoice(
  rl: ConfigurationReadline,
  question: string,
  min: number,
  max: number,
  defaultChoice?: number,
): Promise<number> {
  const suffix = defaultChoice == null ? "" : theme.muted(` [${defaultChoice}]`);
  const raw = await rl.question(`${theme.accent(question)}${suffix}: `);
  const value = raw.trim();
  if (!value && defaultChoice != null) return defaultChoice;

  const choice = Number.parseInt(value, 10);
  if (!Number.isFinite(choice) || choice < min || choice > max) {
    console.log(theme.danger("Invalid selection. Please try again.\n"));
    return promptChoice(rl, question, min, max, defaultChoice);
  }
  return choice;
}

async function promptText(
  rl: ConfigurationReadline,
  question: string,
  options: { defaultValue?: string; allowEmpty?: boolean } = {},
): Promise<string> {
  const suffix = options.defaultValue ? theme.muted(` [${options.defaultValue}]`) : "";
  const raw = await rl.question(`${theme.accent(question)}${suffix}: `);
  const value = raw.trim();
  if (value) return value;
  if (options.defaultValue != null) return options.defaultValue;
  if (options.allowEmpty) return "";
  console.log(theme.danger("Value cannot be empty. Please try again.\n"));
  return promptText(rl, question, options);
}

async function promptSecret(
  rl: ConfigurationReadline,
  currentValue: string,
): Promise<string> {
  const keepHint = currentValue
    ? theme.muted(" (press Enter to keep current key)")
    : "";
  const raw = await rl.question(
    `${theme.accent("Enter OpenRouter API key")}${keepHint}: `,
  );
  const value = raw.trim();
  if (value) return value;
  if (currentValue) return currentValue;
  console.log(theme.danger("Value cannot be empty. Please try again.\n"));
  return promptSecret(rl, currentValue);
}

export function resolveProviderChoice(choice: number): AiProviderId | null {
  if (choice === 1) return "codex";
  if (choice === 2) return "openrouter";
  return null;
}

export async function selectProviderSection(
  rl: ConfigurationReadline,
  options: {
    currentProvider: AiProviderId;
    cancelLabel: "Cancel onboarding" | "Cancel setup";
  },
): Promise<AiProviderId | null> {
  printOption(1, "Sign in with ChatGPT", "Use your Codex subscription.", {
    isCurrent: options.currentProvider === "codex",
  });
  printOption(
    2,
    "OpenRouter API key",
    "Use any model available through OpenRouter.",
    { isCurrent: options.currentProvider === "openrouter" },
  );
  console.log(`${theme.accent("3.")} ${theme.text(options.cancelLabel)}`);

  const defaultChoice = options.currentProvider === "codex" ? 1 : 2;
  const choice = await promptChoice(
    rl,
    "Choose AI provider",
    1,
    3,
    defaultChoice,
  );
  return resolveProviderChoice(choice);
}

export async function authenticateProviderSection(
  rl: ConfigurationReadline,
  options: {
    providerId: AiProviderId;
    currentOpenRouterApiKey: string;
    loginCodex: () => Promise<void>;
  },
): Promise<ProviderAuthResult | null> {
  if (options.providerId === "codex") {
    await options.loginCodex();
    console.log(theme.success("ChatGPT sign-in complete."));
    return { providerId: "codex" };
  }

  console.log(
    theme.warning(
      "Warning: the API key is stored in plaintext inside .chaves.db.",
    ),
  );
  console.log(theme.muted("Do not commit or share that file.\n"));
  const openRouterApiKey = await promptSecret(
    rl,
    options.currentOpenRouterApiKey,
  );
  return { providerId: "openrouter", openRouterApiKey };
}

export async function selectModelSection(
  rl: ConfigurationReadline,
  options: { provider: AiProvider; currentModelId?: string },
): Promise<string | null> {
  return new ModelSetup().selectModel(rl, {
    provider: options.provider,
    defaultModelId: options.currentModelId,
  });
}

export async function selectLanguageSection(
  rl: ConfigurationReadline,
  currentLanguage: string,
): Promise<string | null> {
  return new ModelSetup().selectLanguage(rl, {
    defaultLanguageCode: currentLanguage,
  });
}

export async function editPreferencesSection(
  rl: ConfigurationReadline,
  current: PreferencesResult,
  options: {
    cancelLabel?: "Cancel onboarding" | "Cancel setup";
  } = {},
): Promise<PreferencesResult | null> {
  const cancelLabel = options.cancelLabel ?? "Cancel setup";

  printOption(1, "Level 1: Concise", "Brief, high-signal responses.", {
    isCurrent: current.frequencyLevel === "1",
  });
  printOption(2, "Level 2: Standard", "Balanced conversational flow.", {
    isCurrent: current.frequencyLevel === "2",
  });
  printOption(3, "Level 3: Comprehensive", "More detail and proactive updates.", {
    isCurrent: current.frequencyLevel === "3",
  });
  console.log(`${theme.accent("4.")} ${theme.text(cancelLabel)}`);
  const frequencyChoice = await promptChoice(
    rl,
    "Pick message frequency",
    1,
    4,
    Number.parseInt(current.frequencyLevel, 10),
  );
  if (frequencyChoice === 4) return null;

  printOption(1, "Technical", "Precise and implementation-focused.", {
    isCurrent: current.personality === "technical",
  });
  printOption(2, "Collaborative", "Pragmatic and conversational.", {
    isCurrent: current.personality === "collaborative",
  });
  printOption(3, "Creative", "Explores grounded alternatives and examples.", {
    isCurrent: current.personality === "creative",
  });
  console.log(`${theme.accent("4.")} ${theme.text(cancelLabel)}`);
  const personalityDefault = current.personality === "technical"
    ? 1
    : current.personality === "creative"
      ? 3
      : 2;
  const personalityChoice = await promptChoice(
    rl,
    "Pick personality",
    1,
    4,
    personalityDefault,
  );
  if (personalityChoice === 4) return null;
  const personalities: Record<number, ConfigurationPersonality> = {
    1: "technical",
    2: "collaborative",
    3: "creative",
  };

  printOption(
    1,
    current.devCommand ? "Use or update a dev command" : "Set a dev command",
    current.devCommand
      ? `Current command: ${current.devCommand}`
      : "Examples: npm run dev, bun dev, python manage.py runserver",
  );
  printOption(
    2,
    current.devCommand ? "Keep current command and finish" : "Skip for now",
    current.devCommand
      ? "Leaves terminal capture configured as-is."
      : "You can configure terminal capture later.",
  );
  console.log(`${theme.accent("3.")} ${theme.text(cancelLabel)}`);
  const terminalChoice = await promptChoice(
    rl,
    "Pick terminal capture option",
    1,
    3,
    2,
  );
  if (terminalChoice === 3) return null;

  let devCommand = current.devCommand;
  if (terminalChoice === 1) {
    const entered = await promptText(rl, "Dev command", {
      defaultValue: current.devCommand || undefined,
    });
    devCommand = ["none", "skip", "off"].includes(entered.toLowerCase())
      ? ""
      : entered;
  }

  return {
    frequencyLevel: String(frequencyChoice) as FrequencyLevel,
    personality: personalities[personalityChoice] ?? "collaborative",
    devCommand,
  };
}
