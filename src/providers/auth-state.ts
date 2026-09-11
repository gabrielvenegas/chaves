import { isProviderAuthRequiredError } from "./types.js";

export const CODEX_REAUTHENTICATION_MESSAGE =
  "Your ChatGPT session expired. Run chaves --setup, choose Sign in again, then restart Chaves.";

export interface AiErrorDisposition {
  authRequired: boolean;
  shouldNotify: boolean;
}

export interface InteractiveAiErrorOutcome {
  shouldShowGenericError: boolean;
  storedMessage: string;
}

export function getInteractiveAiErrorOutcome(
  error: unknown,
  disposition: AiErrorDisposition,
): InteractiveAiErrorOutcome {
  return {
    shouldShowGenericError: !disposition.authRequired,
    storedMessage:
      error instanceof Error ? error.message : "Chat response failed",
  };
}

export class AiAvailabilityGate {
  private blocked = false;
  private notified = false;

  canRunBackground(): boolean {
    return !this.blocked;
  }

  handleError(error: unknown): AiErrorDisposition {
    if (!isProviderAuthRequiredError(error)) {
      return { authRequired: false, shouldNotify: false };
    }

    this.blocked = true;
    const shouldNotify = !this.notified;
    this.notified = true;
    return { authRequired: true, shouldNotify };
  }
}
