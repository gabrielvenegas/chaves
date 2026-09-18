import { randomUUID } from "crypto";
import { createInterface } from "readline/promises";
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
import { logger } from "./logger.js";
import type { CodexAuthManager } from "./providers/codex/auth.js";
import {
  createAiProvider,
  createCodexAuthManager,
  type CreateAiProviderInput,
} from "./providers/factory.js";
import type { AiProvider } from "./providers/types.js";
import { Store } from "./store.js";

export type SetupResult = "completed" | "cancelled" | "failed";

export interface SetupWizardInput {
  store: Store;
  projectPath: string;
  rl?: ConfigurationReadline;
  codexAuthManager?: CodexAuthManager;
  createProvider?: (input: CreateAiProviderInput) => AiProvider;
  sessionId?: string;
  userAgent?: string;
}

export interface RunSetupDependencies {
  createStore?: (projectPath: string) => Store;
  runWizard?: (input: SetupWizardInput) => Promise<SetupResult>;
}

function printSetupMenu(): void {
  console.log("1. Change model");
  console.log("2. Change AI provider or account");
  console.log("3. Sign in again");
  console.log("4. Change language");
  console.log("5. Other preferences");
  console.log("6. Cancel");
}

async function selectSetupBranch(rl: ConfigurationReadline): Promise<number> {
  printSetupMenu();
  const answer = await rl.question("Choose setup option: ");
  const choice = Number.parseInt(answer.trim(), 10);
  if (!Number.isFinite(choice) || choice < 1 || choice > 6) {
    console.log("Invalid selection. Please try again.\n");
    return selectSetupBranch(rl);
  }
  return choice;
}

export async function runSetupWizard(
  input: SetupWizardInput,
): Promise<SetupResult> {
  const ownsReadline = !input.rl;
  const rl = input.rl
    ?? createInterface({ input: process.stdin, output: process.stdout });
  const authManager = input.codexAuthManager ?? createCodexAuthManager();
  const providerFactory = input.createProvider ?? createAiProvider;
  const sessionId = input.sessionId ?? randomUUID();
  const userAgent = input.userAgent ?? "chaves/setup";
  const createConfiguredProvider = (
    providerId = input.store.getAiProvider(),
    openRouterApiKey = input.store.getConfig("openrouter_api_key")?.trim() ?? "",
  ): AiProvider => providerId === "openrouter"
    ? providerFactory({ providerId, apiKey: openRouterApiKey })
    : providerFactory({
        providerId,
        auth: authManager,
        sessionId,
        userAgent,
      });

  try {
    const branch = await selectSetupBranch(rl);
    if (branch === 6) return "cancelled";

    if (branch === 1) {
      const provider = createConfiguredProvider();
      const model = await selectModelSection(rl, {
        provider,
        currentModelId: input.store.getModel(),
      });
      if (!model) return "cancelled";
      input.store.setModel(model);
      return "completed";
    }

    if (branch === 2) {
      const providerId = await selectProviderSection(rl, {
        currentProvider: input.store.getAiProvider(),
        cancelLabel: "Cancel setup",
      });
      if (!providerId) return "cancelled";

      const auth = await authenticateProviderSection(rl, {
        providerId,
        currentOpenRouterApiKey:
          input.store.getConfig("openrouter_api_key")?.trim() ?? "",
        loginCodex: async () => {
          await authManager.login();
        },
      });
      if (!auth) return "cancelled";

      const provider = createConfiguredProvider(
        providerId,
        auth.openRouterApiKey,
      );
      const model = await selectModelSection(rl, { provider });
      if (!model) return "cancelled";

      input.store.setAiProviderConfiguration({
        providerId,
        modelId: model,
        openRouterApiKey: auth.openRouterApiKey,
      });
      return "completed";
    }

    if (branch === 3) {
      const providerId = input.store.getAiProvider();
      const auth = await authenticateProviderSection(rl, {
        providerId,
        currentOpenRouterApiKey:
          input.store.getConfig("openrouter_api_key")?.trim() ?? "",
        loginCodex: async () => {
          await authManager.login();
        },
      });
      if (!auth) return "cancelled";
      if (auth.openRouterApiKey != null) {
        input.store.setConfig("openrouter_api_key", auth.openRouterApiKey);
      }
      return "completed";
    }

    if (branch === 4) {
      const language = await selectLanguageSection(rl, input.store.getLanguage());
      if (!language) return "cancelled";
      input.store.setLanguage(language);
      return "completed";
    }

    const preferences = await editPreferencesSection(
      rl,
      {
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
      },
      { cancelLabel: "Cancel setup" },
    );
    if (!preferences) return "cancelled";
    input.store.setConfig("message_frequency_level", preferences.frequencyLevel);
    input.store.setConfig("personality", preferences.personality);
    input.store.setConfig("dev_command", preferences.devCommand);
    return "completed";
  } catch (error) {
    logger.error("SETUP", "Setup wizard failed:", error);
    return "failed";
  } finally {
    if (ownsReadline) rl.close();
  }
}

export async function runSetup(
  projectPath: string,
  dependencies: RunSetupDependencies = {},
): Promise<void> {
  logger.info("SETUP", "Starting Chaves setup wizard");
  const store = dependencies.createStore?.(projectPath) ?? new Store(projectPath);
  const runWizard = dependencies.runWizard ?? runSetupWizard;
  try {
    const result = await runWizard({ store, projectPath });
    if (result === "cancelled") console.log("Setup cancelled.\n");
    if (result === "completed") console.log("Setup complete.\n");
    process.exitCode = result === "failed" ? 1 : 0;
  } finally {
    store.close();
  }
}

export const runSetupCommand = runSetup;
