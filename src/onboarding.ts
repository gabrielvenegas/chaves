import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { createInterface } from "readline/promises";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { ModelSetup } from "./modelSetup.js";
import type { Store } from "./store.js";

const CURRENT_ONBOARDING_VERSION = "1";
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
  warning: chalk.hex("#f6ad55"),
  danger: chalk.hex("#f56565"),
};

type Readline = ReturnType<typeof createInterface>;
type OnboardingResult = "completed" | "skipped" | "aborted";
type InferenceMode = "managed" | "byok";
type FrequencyLevel = "1" | "2" | "3";
type Personality = "technical" | "collaborative" | "creative";

function isNonInteractive(): boolean {
  return !process.stdin.isTTY;
}

function renderRule(label?: string): string {
  const width = Math.max(36, Math.min(process.stdout.columns ?? 80, 88));
  if (!label) {
    return theme.border("─".repeat(width));
  }

  const title = ` ${label.toUpperCase()} `;
  const remaining = Math.max(0, width - title.length);
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${theme.border("─".repeat(left))}${theme.accent(title)}${theme.border("─".repeat(right))}`;
}

function printSection(title: string, description?: string) {
  console.log("");
  console.log(renderRule(title));
  if (description) {
    console.log(theme.muted(description));
  }
  console.log("");
}

function printOption(
  index: number,
  title: string,
  description: string,
  options: { isDefault?: boolean; isCurrent?: boolean } = {},
) {
  const badges = [
    options.isDefault ? theme.success("default") : "",
    options.isCurrent ? theme.muted("current") : "",
  ].filter(Boolean).join(theme.muted(" • "));

  const suffix = badges ? ` ${theme.muted(`[${badges}]`)}` : "";
  console.log(`${theme.accent(`${index}.`)} ${theme.text(title)}${suffix}`);
  console.log(`   ${theme.muted(description)}`);
}

function printSummaryLine(label: string, value: string) {
  console.log(`${theme.success("✓")} ${theme.text(label)} ${theme.muted("•")} ${value}`);
}

function printBanner(projectPath: string) {
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

async function promptChoice(
  rl: Readline,
  question: string,
  min: number,
  max: number,
  defaultChoice?: number,
): Promise<number> {
  const defaultSuffix =
    defaultChoice == null ? "" : theme.muted(` [${defaultChoice}]`);
  const raw = await rl.question(
    `${theme.accent(question)}${defaultSuffix}: `,
  );
  const normalized = raw.trim();

  if (!normalized && defaultChoice != null) {
    return defaultChoice;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.log(theme.danger("Invalid selection. Please try again.\n"));
    return promptChoice(rl, question, min, max, defaultChoice);
  }

  return parsed;
}

async function promptText(
  rl: Readline,
  question: string,
  options: {
    allowEmpty?: boolean;
    defaultValue?: string;
    emptyMessage?: string;
  } = {},
): Promise<string> {
  const defaultSuffix = options.defaultValue
    ? theme.muted(` [${options.defaultValue}]`)
    : "";
  const raw = await rl.question(`${theme.accent(question)}${defaultSuffix}: `);
  const value = raw.trim();

  if (!value) {
    if (options.defaultValue != null) {
      return options.defaultValue;
    }
    if (options.allowEmpty) {
      return "";
    }

    console.log(
      theme.danger(options.emptyMessage ?? "Value cannot be empty. Please try again.\n"),
    );
    return promptText(rl, question, options);
  }

  return value;
}

async function promptNonEmptySecret(
  rl: Readline,
  question: string,
  options: { keepCurrentLabel?: string; currentValue?: string } = {},
): Promise<string> {
  const keepHint = options.currentValue
    ? theme.muted(` (${options.keepCurrentLabel ?? "press Enter to keep current"})`)
    : "";
  const raw = await rl.question(`${theme.accent(question)}${keepHint}: `);
  const value = raw.trim();

  if (!value && options.currentValue) {
    return options.currentValue;
  }

  if (!value) {
    console.log(theme.danger("Value cannot be empty. Please try again.\n"));
    return promptNonEmptySecret(rl, question, options);
  }

  return value;
}

function needsOnboarding(store: Store): boolean {
  const completed = store.getConfig("onboarding_completed");
  const version = store.getConfig("onboarding_version");
  return completed !== "true" || version !== CURRENT_ONBOARDING_VERSION;
}

export async function runOnboardingIfNeeded(input: {
  projectPath: string;
  store: Store;
  force: boolean;
}): Promise<OnboardingResult> {
  if (!input.force && !needsOnboarding(input.store)) return "skipped";

  if (isNonInteractive()) {
    console.log(
      [
        "Chaves onboarding requires an interactive terminal.",
        "Run again in a TTY, or run:",
        `  bun run setup ${input.projectPath}`,
        "",
        "AI requires OPENROUTER_API_KEY (managed inference uses env; BYOK stores a per-project key).",
      ].join("\n"),
    );
    return "aborted";
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const existingInferenceMode = input.store.getConfigEnum(
      "inference_mode",
      ["managed", "byok"] as const,
      "managed",
    ) as InferenceMode;
    const existingApiKey = input.store.getConfig("openrouter_api_key")?.trim() ?? "";
    const existingModel = input.store.getModel();
    const existingLanguage = input.store.getLanguage();
    const existingFrequencyLevel = input.store.getConfigEnum(
      "message_frequency_level",
      ["1", "2", "3"] as const,
      "2",
    ) as FrequencyLevel;
    const existingPersonality = input.store.getConfigEnum(
      "personality",
      ["technical", "collaborative", "creative"] as const,
      "collaborative",
    ) as Personality;
    const existingDevCommand = input.store.getConfig("dev_command")?.trim() ?? "";

    let inferenceMode = existingInferenceMode;
    let apiKey = existingApiKey;
    let model = existingModel;
    let language = existingLanguage;
    let frequencyLevel = existingFrequencyLevel;
    let personality = existingPersonality;
    let devCommand = existingDevCommand;

    printBanner(input.projectPath);

    printSection(
      "Inference",
      "Choose how Chaves should authenticate with OpenRouter for this project.",
    );
    printOption(
      1,
      "Managed inference",
      "Uses your global OPENROUTER_API_KEY from the environment.",
      {
        isDefault: existingInferenceMode === "managed",
        isCurrent: existingInferenceMode === "managed",
      },
    );
    printOption(
      2,
      "BYOK (Bring Your Own Key)",
      "Stores a project-specific API key inside .chaves.db.",
      {
        isDefault: existingInferenceMode === "byok",
        isCurrent: existingInferenceMode === "byok",
      },
    );
    printOption(3, "Cancel onboarding", "Exit without changing settings.");

    const inferenceChoice = await promptChoice(
      rl,
      "Pick inference mode",
      1,
      3,
      existingInferenceMode === "byok" ? 2 : 1,
    );
    if (inferenceChoice === 3) return "aborted";

    inferenceMode = inferenceChoice === 2 ? "byok" : "managed";
    if (inferenceMode === "byok") {
      console.log("");
      console.log(
        theme.warning(
          "Warning: the API key is stored in plaintext inside .chaves.db.",
        ),
      );
      console.log(theme.muted("Do not commit or share that file.\n"));

      apiKey = await promptNonEmptySecret(rl, "Enter OpenRouter API key", {
        currentValue:
          existingInferenceMode === "byok" && existingApiKey
            ? existingApiKey
            : undefined,
      });
    } else {
      apiKey = "";
    }

    printSection(
      "Model",
      "Pick the model Chaves should use for summaries and chat analysis.",
    );

    const setup = new ModelSetup();
    const selectedModel = await setup.selectModel(rl, {
      defaultModelId: existingModel,
    });
    if (!selectedModel) return "aborted";
    model = selectedModel;

    printSection(
      "Language",
      "Choose the language Chaves should use in its responses.",
    );
    const selectedLanguage = await setup.selectLanguage(rl, {
      defaultLanguageCode: existingLanguage,
    });
    if (!selectedLanguage) return "aborted";
    language = selectedLanguage;

    printSection(
      "Message frequency",
      "Control how concise or how proactive Chaves should be while you work.",
    );
    printOption(
      1,
      "Level 1: Concise",
      "Brief, high-signal responses with fewer proactive updates.",
      {
        isDefault: existingFrequencyLevel === "1",
        isCurrent: existingFrequencyLevel === "1",
      },
    );
    printOption(
      2,
      "Level 2: Standard",
      "Balanced conversational flow for everyday use.",
      {
        isDefault: existingFrequencyLevel === "2",
        isCurrent: existingFrequencyLevel === "2",
      },
    );
    printOption(
      3,
      "Level 3: Comprehensive",
      "More detailed answers and more frequent updates.",
      {
        isDefault: existingFrequencyLevel === "3",
        isCurrent: existingFrequencyLevel === "3",
      },
    );
    printOption(4, "Cancel onboarding", "Exit without changing settings.");

    const frequencyChoice = await promptChoice(
      rl,
      "Pick message frequency",
      1,
      4,
      Number.parseInt(existingFrequencyLevel, 10),
    );
    if (frequencyChoice === 4) return "aborted";
    frequencyLevel = String(frequencyChoice) as FrequencyLevel;

    printSection(
      "Personality",
      "Set the tone Chaves should default to in this project.",
    );
    printOption(
      1,
      "Technical",
      "Precise, implementation-focused, with fewer analogies.",
      {
        isDefault: existingPersonality === "technical",
        isCurrent: existingPersonality === "technical",
      },
    );
    printOption(
      2,
      "Collaborative",
      "Pragmatic and conversational, asking questions when needed.",
      {
        isDefault: existingPersonality === "collaborative",
        isCurrent: existingPersonality === "collaborative",
      },
    );
    printOption(
      3,
      "Creative",
      "Explores alternatives and examples while staying grounded.",
      {
        isDefault: existingPersonality === "creative",
        isCurrent: existingPersonality === "creative",
      },
    );
    printOption(4, "Cancel onboarding", "Exit without changing settings.");

    const personalityChoice = await promptChoice(
      rl,
      "Pick personality",
      1,
      4,
      existingPersonality === "technical"
        ? 1
        : existingPersonality === "creative"
          ? 3
          : 2,
    );
    if (personalityChoice === 4) return "aborted";

    const personalityMap: Record<number, Personality> = {
      1: "technical",
      2: "collaborative",
      3: "creative",
    };
    personality = personalityMap[personalityChoice] ?? "collaborative";

    printSection(
      "Terminal capture",
      "Optionally let Chaves watch your dev process output so it can react to runtime logs and errors.",
    );
    printOption(
      1,
      existingDevCommand ? "Use or update a dev command" : "Set a dev command",
      existingDevCommand
        ? `Current command: ${existingDevCommand}`
        : "Examples: npm run dev, bun dev, python manage.py runserver",
    );
    printOption(
      2,
      existingDevCommand ? "Keep current command and finish" : "Skip for now",
      existingDevCommand
        ? "Leaves terminal capture configured as-is."
        : "You can configure terminal capture later.",
      { isDefault: true },
    );
    printOption(3, "Cancel onboarding", "Exit without changing settings.");

    const terminalChoice = await promptChoice(
      rl,
      "Pick terminal capture option",
      1,
      3,
      2,
    );
    if (terminalChoice === 3) return "aborted";

    if (terminalChoice === 1) {
      const enteredCommand = await promptText(rl, "Dev command", {
        defaultValue: existingDevCommand || undefined,
      });
      const normalized = enteredCommand.trim();
      devCommand =
        ["none", "skip", "off"].includes(normalized.toLowerCase())
          ? ""
          : normalized;
    }

    input.store.setConfig("inference_mode", inferenceMode);
    input.store.setConfig(
      "openrouter_api_key",
      inferenceMode === "byok" ? apiKey : "",
    );
    input.store.setModel(model);
    input.store.setLanguage(language);
    input.store.setConfig("message_frequency_level", frequencyLevel);
    input.store.setConfig("personality", personality);
    input.store.setConfig("dev_command", devCommand);
    input.store.setConfig("onboarding_completed", "true");
    input.store.setConfig("onboarding_version", CURRENT_ONBOARDING_VERSION);
    input.store.setConfig(
      "onboarding_completed_at",
      new Date().toISOString(),
    );

    printSection("Summary", "Saved settings for this project.");
    printSummaryLine(
      "Inference",
      inferenceMode === "byok"
        ? theme.text("BYOK (project key)")
        : theme.text("Managed via OPENROUTER_API_KEY"),
    );
    printSummaryLine("Model", theme.text(model));
    printSummaryLine("Language", theme.text(language));
    printSummaryLine(
      "Message frequency",
      theme.text(
        frequencyLevel === "1"
          ? "Level 1: Concise"
          : frequencyLevel === "3"
            ? "Level 3: Comprehensive"
            : "Level 2: Standard",
      ),
    );
    printSummaryLine(
      "Personality",
      theme.text(
        personality === "technical"
          ? "Technical"
          : personality === "creative"
            ? "Creative"
            : "Collaborative",
      ),
    );
    printSummaryLine(
      "Terminal capture",
      devCommand ? theme.text(devCommand) : theme.muted("Not configured"),
    );

    console.log("");
    console.log(theme.success("Onboarding complete."));
    console.log("");
    return "completed";
  } finally {
    rl.close();
  }
}
