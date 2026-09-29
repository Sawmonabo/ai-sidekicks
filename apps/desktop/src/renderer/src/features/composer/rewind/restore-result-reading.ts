// What a settled rollback says, read exhaustively: one switch per settlement class with a
// `never` tail, so a new arm fails the build rather than falling through. The class comes
// from the response's own state; nothing here infers it from a disposition name. A degraded
// settlement is never reported as a success.

import type { RollbackAppliedResult, RollbackDegradedResult } from "@ai-sidekicks/contracts";
import type { ChipTone } from "@renderer/console/primitives/index.js";

/** What one settled rollback says, in the console's words. */
export interface RestoreResultReading {
  /** The wire literal, rendered verbatim in mono. */
  readonly disposition: string;
  /** `applied` or `degraded`, from the response's own state. */
  readonly settlementClass: "applied" | "degraded";
  readonly tone: ChipTone;
  /** One sentence naming what happened to the conversation and to the tree. */
  readonly summary: string;
}

/**
 * Read a settled `applied` rollback.
 *
 * The class is the daemon's answer, taken from the response's state rather than guessed from
 * the disposition name.
 */
export function readAppliedRestore(result: RollbackAppliedResult): RestoreResultReading {
  const shared = {
    disposition: result.disposition,
    settlementClass: "applied",
    tone: "accent",
  } as const;
  switch (result.disposition) {
    case "files-restored":
      return {
        ...shared,
        summary:
          "The rewind landed and the working tree was restored to the boundary. The run is paused at the confirmed position; nothing resumes on its own.",
      };
    case "conversation-only":
      return {
        ...shared,
        summary:
          "The rewind landed in the conversation. No file was restored, because this run had no working tree to restore. The run is paused at the confirmed position.",
      };
    default:
      return unreachableDisposition(result);
  }
}

/** Read a settled `degraded` rollback. */
export function readPartialRestore(result: RollbackDegradedResult): RestoreResultReading {
  const shared = {
    disposition: result.disposition,
    settlementClass: "degraded",
    tone: "attention",
  } as const;
  switch (result.disposition) {
    case "nothing-applied":
      return {
        ...shared,
        summary:
          "Nothing was applied. The run, the conversation, and the working tree are all as they were.",
      };
    case "resend-unapplied":
      return {
        ...shared,
        summary:
          "The rewind landed and the working tree was restored; the replacement message was not admitted. Your text is not lost — it is held on the intervention record.",
      };
    default:
      return unreachableDisposition(result);
  }
}

/**
 * What the settlement says about the caller's replacement text.
 *
 * `undefined` for every disposition but `resend-unapplied`, the only one that reports a
 * replacement that did not go through.
 */
export function resendSettlementSentence(disposition: string): string | undefined {
  if (disposition === "resend-unapplied") {
    return "Your replacement message was not admitted. It stays recoverable on the intervention record.";
  }
  return undefined;
}

/**
 * The `satisfies never` tail, as a function so both switches share it.
 *
 * A new disposition makes the parameter no longer `never`, so the call fails to compile at
 * both call sites rather than rendering a nameless settlement.
 */
function unreachableDisposition(result: never): never {
  const unreadable = result satisfies never;
  throw new Error(
    `the rollback result carried a disposition this console has no reading for: ${JSON.stringify(unreadable)}`,
  );
}
