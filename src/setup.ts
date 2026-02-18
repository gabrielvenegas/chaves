import { ModelSetup } from "./modelSetup.js";
import { Store } from "./store.js";
import { logger } from "./logger.js";

export async function runSetup(projectPath: string): Promise<void> {
  logger.info("SETUP", "🔧 Starting Chaves setup wizard");

  const store = new Store(projectPath);
  const modelSetup = new ModelSetup();

  try {
    const selectedLanguage = await modelSetup.selectLanguage();

    if (!selectedLanguage) {
      console.log("Setup cancelled.\n");
      logger.info("SETUP", "Setup cancelled by user");
      process.exit(0);
    }

    const selectedModel = await modelSetup.selectModel();

    if (selectedModel) {
      await modelSetup.saveModelToStore(store, selectedModel);
      console.log(
        `✨ Setup complete! Using model: ${selectedModel} and language: ${selectedLanguage}\n`,
      );
      logger.info("SETUP", "✅ Setup wizard completed successfully");
      process.exit(0);
    } else {
      console.log("Setup cancelled.\n");
      logger.info("SETUP", "Setup cancelled by user");
      process.exit(0);
    }
  } catch (error) {
    logger.error("SETUP", "Setup wizard failed:", error);
    console.error("Setup failed:", error);
    process.exit(1);
  }
}
