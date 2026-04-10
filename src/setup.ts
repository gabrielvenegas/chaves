import { createInterface } from "readline/promises";
import { ModelSetup } from "./modelSetup.js";
import { Store } from "./store.js";
import { logger } from "./logger.js";

export async function runSetupWizard(
  store: Store,
): Promise<{ model: string; language: string } | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const modelSetup = new ModelSetup();

  try {
    const model = await modelSetup.selectModel(rl);
    if (!model) return null;

    const language = await modelSetup.selectLanguage(rl);
    if (!language) return null;

    modelSetup.saveToStore(store, { model, language });
    return { model, language };
  } finally {
    rl.close();
  }
}

export async function runSetupCommand(projectPath: string): Promise<void> {
  logger.info("SETUP", "Starting Chaves setup wizard");
  const store = new Store(projectPath);

  try {
    const result = await runSetupWizard(store);
    if (!result) {
      console.log("Setup cancelled.\n");
      process.exit(0);
    }

    console.log(
      `Setup complete. Using model: ${result.model} and language: ${result.language}\n`,
    );
    process.exit(0);
  } catch (error) {
    logger.error("SETUP", "Setup wizard failed:", error);
    console.error("Setup failed:", error);
    process.exit(1);
  }
}

// Back-compat entrypoint used by src/index.ts
export async function runSetup(projectPath: string): Promise<void> {
  return runSetupCommand(projectPath);
}

