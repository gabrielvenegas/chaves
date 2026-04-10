import type { createInterface } from "readline/promises";
import chalk from "chalk";
import { logger } from "./logger.js";
import type { Store } from "./store.js";

type Readline = ReturnType<typeof createInterface>;

interface Model {
  id: string;
  name: string;
  description?: string;
}

interface Language {
  code: string;
  name: string;
}

const theme = {
  accent: chalk.hex("#f4bc69"),
  text: chalk.hex("#f2dfc3"),
  muted: chalk.hex("#ab9784"),
  success: chalk.hex("#c8d35a"),
  danger: chalk.hex("#f56565"),
};

export const POPULAR_MODELS: Model[] = [
  {
    id: "anthropic/claude-3.5-haiku",
    name: "Claude 3.5 Haiku",
    description: "Fast and efficient for code analysis",
  },
  {
    id: "anthropic/claude-3-opus",
    name: "Claude 3 Opus",
    description: "Most capable for complex tasks",
  },
  {
    id: "anthropic/claude-3-sonnet",
    name: "Claude 3 Sonnet",
    description: "Balanced performance and cost",
  },
  {
    id: "openai/gpt-4-turbo",
    name: "GPT-4 Turbo",
    description: "Powerful model with vision capabilities",
  },
  {
    id: "openai/gpt-4",
    name: "GPT-4",
    description: "Reliable and capable general model",
  },
  {
    id: "openai/gpt-3.5-turbo",
    name: "GPT-3.5 Turbo",
    description: "Fast and cost-effective",
  },
  {
    id: "meta-llama/llama-2-70b-chat",
    name: "Llama 2 70B",
    description: "Open source model",
  },
  {
    id: "mistralai/mistral-large",
    name: "Mistral Large",
    description: "Efficient open source option",
  },
];

const SUPPORTED_LANGUAGES: Language[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "pt-BR", name: "Portuguese (Brazil)" },
  { code: "ru", name: "Russian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
];

export class ModelSetup {
  private selectedLanguage = "en";

  getSelectedLanguage(): string {
    return this.selectedLanguage;
  }

  async selectModel(
    rl: Readline,
    options: { defaultModelId?: string } = {},
  ): Promise<string | null> {
    logger.info("MODEL_SETUP", "Starting model selection...");

    const defaultIndex = Math.max(
      1,
      POPULAR_MODELS.findIndex((model) => model.id === options.defaultModelId) +
        1 || 1,
    );

    console.log(theme.text("Available OpenRouter models:\n"));

    POPULAR_MODELS.forEach((model, index) => {
      const num = index + 1;
      const badges = [
        model.id === options.defaultModelId ? theme.success("current") : "",
      ].filter(Boolean).join(theme.muted(" • "));
      const suffix = badges ? ` ${theme.muted(`[${badges}]`)}` : "";

      console.log(`${theme.accent(`${num}.`)} ${theme.text(model.name)}${suffix}`);
      console.log(`   ${theme.muted(model.id)}`);
      if (model.description) {
        console.log(`   ${theme.muted(model.description)}`);
      }
    });

    console.log(
      `\n${theme.accent(`${POPULAR_MODELS.length + 1}.`)} ${theme.text("Enter custom model ID")}`,
    );
    console.log(
      `${theme.accent(`${POPULAR_MODELS.length + 2}.`)} ${theme.text("Cancel")}\n`,
    );

    const choice = await rl.question(
      `${theme.accent("Select a model")}${theme.muted(` [${defaultIndex}]`)}: `,
    );
    const selection = Number.parseInt(choice.trim() || String(defaultIndex), 10);

    if (
      !Number.isFinite(selection) ||
      selection < 1 ||
      selection > POPULAR_MODELS.length + 2
    ) {
      console.log(theme.danger("Invalid selection. Please try again.\n"));
      return this.selectModel(rl, options);
    }

    if (selection === POPULAR_MODELS.length + 2) {
      logger.info("MODEL_SETUP", "Model selection cancelled by user");
      return null;
    }

    if (selection === POPULAR_MODELS.length + 1) {
      const customModel = await rl.question(
        `${theme.accent("Enter model ID")}${
          options.defaultModelId
            ? theme.muted(` [${options.defaultModelId}]`)
            : ""
        }: `,
      );
      const modelId = customModel.trim();
      if (!modelId && options.defaultModelId) {
        logger.info("MODEL_SETUP", `Keeping current model: ${options.defaultModelId}`);
        return options.defaultModelId;
      }

      if (!modelId) {
        console.log(theme.danger("Model ID cannot be empty.\n"));
        return this.selectModel(rl, options);
      }
      logger.info("MODEL_SETUP", `Custom model selected: ${modelId}`);
      return modelId;
    }

    const selectedModel = POPULAR_MODELS[selection - 1]!;
    console.log(
      `\n${theme.success("Selected")}: ${theme.text(selectedModel.name)} ${theme.muted(`(${selectedModel.id})`)}\n`,
    );
    logger.info("MODEL_SETUP", `Model selected: ${selectedModel.id}`);
    return selectedModel.id;
  }

  async selectLanguage(
    rl: Readline,
    options: { defaultLanguageCode?: string } = {},
  ): Promise<string | null> {
    logger.info("MODEL_SETUP", "Starting language selection...");

    const defaultIndex = Math.max(
      1,
      SUPPORTED_LANGUAGES.findIndex(
        (lang) => lang.code === options.defaultLanguageCode,
      ) + 1 || 1,
    );

    console.log(theme.text("Available languages:\n"));

    SUPPORTED_LANGUAGES.forEach((lang, index) => {
      const num = index + 1;
      const badges = [
        lang.code === options.defaultLanguageCode ? theme.success("current") : "",
      ].filter(Boolean).join(theme.muted(" • "));
      const suffix = badges ? ` ${theme.muted(`[${badges}]`)}` : "";

      console.log(
        `${theme.accent(`${num}.`)} ${theme.text(lang.name)} ${theme.muted(`(${lang.code})`)}${suffix}`,
      );
    });

    console.log(
      `\n${theme.accent(`${SUPPORTED_LANGUAGES.length + 1}.`)} ${theme.text("Cancel")}\n`,
    );

    const choice = await rl.question(
      `${theme.accent("Select a language")}${theme.muted(` [${defaultIndex}]`)}: `,
    );
    const selection = Number.parseInt(choice.trim() || String(defaultIndex), 10);

    if (
      !Number.isFinite(selection) ||
      selection < 1 ||
      selection > SUPPORTED_LANGUAGES.length + 1
    ) {
      console.log(theme.danger("Invalid selection. Please try again.\n"));
      return this.selectLanguage(rl, options);
    }

    if (selection === SUPPORTED_LANGUAGES.length + 1) {
      logger.info("MODEL_SETUP", "Language selection cancelled by user");
      return null;
    }

    const selected = SUPPORTED_LANGUAGES[selection - 1]!;
    this.selectedLanguage = selected.code;
    console.log(
      `\n${theme.success("Selected")}: ${theme.text(selected.name)} ${theme.muted(`(${selected.code})`)}\n`,
    );
    logger.info("MODEL_SETUP", `Language selected: ${selected.code}`);
    return selected.code;
  }

  saveToStore(store: Store, input: { model: string; language: string }) {
    store.setModel(input.model);
    store.setLanguage(input.language);
    logger.info("MODEL_SETUP", `Model saved to configuration: ${input.model}`);
    logger.info(
      "MODEL_SETUP",
      `Language saved to configuration: ${input.language}`,
    );
  }
}
