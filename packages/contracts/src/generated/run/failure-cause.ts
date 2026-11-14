// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Why a run failed, as `agent.run.failed` records it: one closed union of causes, each provider's own normalized into it by its driver.

import type { CredentialGeneration, ProviderAccountId } from "../provider/account/record.js";
import type { ProviderUsageLimitResetBoundary } from "../provider/driver/usage-limit.js";

/**
 * Who ended a refused turn: the provider, whose cause the driver normalized, or the app's own
 * refusal.
 */
export type RunRefusedOrigin = "provider" | "daemon";
/**
 * Why a run failed, on `agent.run.failed`, discriminated on `cause`: the refusal, the provider's
 * usage limit, the provider's spent retries, a setup gate's failure, a turn too long for the
 * context window, or no flex capacity for a turn on flex. A reload redraws the run's last row from
 * this cause alone.
 */
export type RunFailureCause =
  | {
      cause: "refused";
      /**
       * Who ended the turn.
       */
      origin: RunRefusedOrigin;
      /**
       * The refusing model.
       */
      model: string;
      /**
       * The provider's own sentence, where it sent one.
       */
      sentence?: string;
      /**
       * The provider's explanation, shown verbatim, where it sent one.
       */
      explanation?: string;
      /**
       * The provider's open safety category, such as `cyber`, where it sent one.
       */
      safetyCategory?: string;
    }
  | {
      cause: "planAllowanceExhausted";
      /**
       * Always `provider`.
       */
      origin: "provider";
      /**
       * The account whose allowance is spent.
       */
      providerAccountId: ProviderAccountId;
      /**
       * The account's credential generation when the limit was met.
       */
      credentialGeneration: CredentialGeneration;
      /**
       * When the spent window resets; absent when no reset instant was known.
       */
      resetBoundary?: ProviderUsageLimitResetBoundary;
    }
  | {
      cause: "retriesExhausted";
      /**
       * Always `provider`.
       */
      origin: "provider";
    }
  | {
      cause: "setupFailed";
      /**
       * Always `daemon`.
       */
      origin: "daemon";
      /**
       * The gate's error code, such as `workspace.executionRoot.unresolved`.
       */
      code?: string;
      /**
       * The gate's own words.
       */
      message: string;
    }
  | {
      cause: "contextWindowExceeded";
      /**
       * Always `provider`.
       */
      origin: "provider";
      /**
       * The message that goes back to the composer.
       */
      returnedMessageId: string;
    }
  | {
      cause: "flexCapacityUnavailable";
      /**
       * Always `provider`.
       */
      origin: "provider";
    };

export { validateRunFailureCause, validateRunRefusedOrigin } from "../checks/run/failure-cause.js";
