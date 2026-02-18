import { createInterface } from "readline/promises";
import { logger } from "./logger.js";
import type { Store } from "./store.js";

interface Model {
  id: string;
  name: string;
  description?: string;
}

interface Language {
  code: string;
  name: string;
}

// Popular models from OpenRouter
const POPULAR_MODELS: Model[] = [
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

// Supported languages
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
  private rl: ReturnType<typeof createInterface>;
  private selectedLanguage: string = "en";

  constructor() {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async selectLanguage(): Promise<string> {
    logger.info("MODEL_SETUP", "🌐 Starting language selection...");

    try {
      console.log("\n📋 Available Languages:\n");

      SUPPORTED_LANGUAGES.forEach((lang, index) => {
        const num = index + 1;
        console.log(`${num}. ${lang.name} (${lang.code})`);
      });

      console.log(`\n${SUPPORTED_LANGUAGES.length + 1}. Cancel setup\n`);

      const choice = await this.rl.question(
        "Select a language (enter number): ",
      );
      const selection = parseInt(choice.trim(), 10);

      if (
        selection < 1 ||
        selection > SUPPORTED_LANGUAGES.length + 1 ||
        isNaN(selection)
      ) {
        logger.warn("MODEL_SETUP", "Invalid selection");
        console.log("❌ Invalid selection. Please try again.\n");
        return this.selectLanguage();
      }

      if (selection === SUPPORTED_LANGUAGES.length + 1) {
        logger.info("MODEL_SETUP", "Setup cancelled by user");
        console.log("Setup cancelled.\n");
        this.rl.close();
        return "";
      }

      if (selection >= 1 && selection <= SUPPORTED_LANGUAGES.length) {
        const selectedLanguage = SUPPORTED_LANGUAGES[selection - 1]!;
        this.selectedLanguage = selectedLanguage.code;
        logger.info(
          "MODEL_SETUP",
          `Language selected: ${selectedLanguage.name} (${selectedLanguage.code})`,
        );
        console.log(
          `\n✅ Selected: ${selectedLanguage.name} (${selectedLanguage.code})\n`,
        );

        return selectedLanguage.code;
      }

      logger.warn("MODEL_SETUP", "Invalid language selection");
      console.log("❌ Invalid selection. Please try again.\n");
      return this.selectLanguage();
    } catch (error) {
      logger.error("MODEL_SETUP", "Error during language selection:", error);
      this.rl.close();
      throw error;
    }
  }

  async selectModel(): Promise<string> {
    logger.info("MODEL_SETUP", "🎯 Starting model selection...");

    try {
      console.log("\n📋 Available OpenRouter Models:\n");

      POPULAR_MODELS.forEach((model, index) => {
        const num = index + 1;
        console.log(`${num}. ${model.name}`);
        if (model.description) {
          console.log(`   └─ ${model.description}`);
        }
      });

      console.log(`\n${POPULAR_MODELS.length + 1}. Enter custom model ID`);
      console.log(`${POPULAR_MODELS.length + 2}. Cancel setup\n`);

      const choice = await this.rl.question("Select a model (enter number): ");
      const selection = parseInt(choice.trim(), 10);

      if (
        selection < 1 ||
        selection > POPULAR_MODELS.length + 2 ||
        isNaN(selection)
      ) {
        logger.warn("MODEL_SETUP", "Invalid selection");
        console.log("❌ Invalid selection. Please try again.\n");
        return this.selectModel();
      }

      if (selection === POPULAR_MODELS.length + 2) {
        logger.info("MODEL_SETUP", "Setup cancelled by user");
        console.log("Setup cancelled.\n");
        this.rl.close();
        return "";
      }

      if (selection === POPULAR_MODELS.length + 1) {
        const customModel = await this.rl.question("Enter model ID: ");
        const modelId = customModel.trim();

        if (!modelId) {
          logger.warn("MODEL_SETUP", "Empty custom model ID");
          console.log("❌ Model ID cannot be empty.\n");
          return this.selectModel();
        }

        logger.info("MODEL_SETUP", `Custom model selected: ${modelId}`);
        this.rl.close();
        return modelId;
      }

      if (selection >= 1 && selection <= POPULAR_MODELS.length) {
        const selectedModel = POPULAR_MODELS[selection - 1]!;
        logger.info(
          "MODEL_SETUP",
          `Model selected: ${selectedModel.id} (${selectedModel.name})`,
        );
        console.log(
          `\n✅ Selected: ${selectedModel.name} (${selectedModel.id})\n`,
        );

        this.rl.close();
        return selectedModel.id;
      }

      logger.warn("MODEL_SETUP", "Invalid model selection");
      console.log("❌ Invalid selection. Please try again.\n");
      return this.selectModel();
    } catch (error) {
      logger.error("MODEL_SETUP", "Error during model selection:", error);
      this.rl.close();
      throw error;
    }
  }

  async saveModelToStore(store: Store, model: string): Promise<void> {
    if (model) {
      store.setModel(model);
      store.setLanguage(this.selectedLanguage);
      logger.info("MODEL_SETUP", `✅ Model saved to configuration: ${model}`);
      logger.info(
        "MODEL_SETUP",
        `✅ Language saved to configuration: ${this.selectedLanguage}`,
      );
    }
  }
}
