// The nine rollback dispositions, read exhaustively.
//
// THIS MODULE'S OWN RULE, because no committed document states it: one exhaustive
// switch over nine arms with a `satisfies never` tail, so a tenth arm fails the
// build rather than falling through. It is a pure function over the registered
// result union, so the whole disposition vocabulary can be asserted without
// rendering anything.
//
// FIVE PROPERTIES OF THE READING, EACH ONE FIXED BY THAT REGISTERED UNION
// (`api-payload-contracts.md §Plan-004`) RATHER THAN CHOSEN HERE.
//
//   • **The class is read from the type, never asserted in prose.** `applied`
//     admits exactly `files-restored` and `conversation-only`; every other
//     disposition is `degraded`. The caller passes the response's own `state`, and
//     this module never infers one from the disposition name.
//   • **The two file enumerations are never silent.** They are REQUIRED and
//     empty-when-none on `files-restored`, `files-partially-restored`, and
//     `resend-unapplied`, so the reading carries them on exactly those three arms
//     and the renderer shows the count on all three. An empty list means nothing
//     was overwritten or diverged; absence is a parse failure the schema already
//     refuses, so a reader can never mistake absence for none.
//   • **Positions are daemon-supplied.** `position-mismatch` carries the requested
//     and confirmed positions, `boundary-diverged` the confirmed and the newest
//     boundary — the latter typed NULLABLE, because a position-less compaction row
//     classifies as crossing for every target of that run. Nothing here computes a
//     cut, on `Spec-023 §Rules every console surface obeys`' rule that "eligibility
//     is never projected by the renderer".
//   • **`resendDisposition` is read, never inferred.** It is schema-optional
//     everywhere except `resend-unapplied`, where it is required, and its value is
//     state-determined. The reading passes it through and does not derive the
//     resend outcome from the disposition taxonomy.
//   • **A degraded settlement is never reported as a success**, and the copy for
//     the composite says the replacement is QUEUED and sends on the next resume —
//     never "sent", because the composite admits the replacement run-bound and does
//     not dispatch it.

import type {
  RollbackAppliedResendOutcome,
  RollbackAppliedResult,
  RollbackDegradedResendOutcome,
  RollbackDegradedResult,
} from "@ai-sidekicks/contracts";
import type { ChipTone } from "../../primitives/index.js";

/** The two file enumerations, carried together because they are never carried apart. */
export interface RollbackFileEnumerations {
  readonly overwrittenIgnoredPaths: readonly string[];
  readonly divergentGitlinks: readonly string[];
}

/** One daemon-supplied position the reading renders by name. */
export interface RollbackPositionReading {
  readonly label: string;
  /** `null` where the wire says so — never a stand-in the console chose. */
  readonly position: number | null;
}

/** What one settled rollback says, in the console's words and the daemon's figures. */
export interface RollbackDispositionReading {
  /** The wire literal, rendered verbatim in mono. */
  readonly disposition: string;
  /** `applied` or `degraded`, from the response's own state. */
  readonly settlementClass: "applied" | "degraded";
  readonly tone: ChipTone;
  /** One sentence naming what happened to the conversation and to the tree. */
  readonly summary: string;
  /** Present on exactly the three arms whose enumerations are never silent. */
  readonly files: RollbackFileEnumerations | undefined;
  /** Daemon-supplied positions, in the order the participant reads them. */
  readonly positions: readonly RollbackPositionReading[];
  /** Read off the result, never inferred from the disposition. */
  readonly resendDisposition: "admitted" | "unapplied" | undefined;
  /**
   * Whether a later resume of this run refuses as a standing rule rather than a
   * transient failure. `boundary-diverged` is the V1 non-resumable class.
   */
  readonly isNonResumable: boolean;
}

/**
 * Read a settled `applied` rollback.
 *
 * The `state` is the caller's, taken from `InterventionRequestResponse`, so the
 * class is the daemon's answer rather than a name-based guess.
 */
export function readAppliedRollback(
  result: RollbackAppliedResult & RollbackAppliedResendOutcome,
): RollbackDispositionReading {
  const shared = {
    disposition: result.disposition,
    settlementClass: "applied",
    tone: "accent",
    resendDisposition: result.resendDisposition,
    isNonResumable: false,
  } as const;
  switch (result.disposition) {
    case "files-restored":
      return {
        ...shared,
        summary:
          "The rewind landed and the working tree was restored to the boundary. The run is paused at the confirmed position; nothing resumes on its own.",
        files: {
          overwrittenIgnoredPaths: result.overwrittenIgnoredPaths,
          divergentGitlinks: result.divergentGitlinks,
        },
        positions: [],
      };
    case "conversation-only":
      return {
        ...shared,
        summary:
          "The rewind landed in the conversation. No file was restored, because this run had no working tree to restore. The run is paused at the confirmed position.",
        files: undefined,
        positions: [],
      };
    default:
      return unreachableDisposition(result);
  }
}

/** Read a settled `degraded` rollback. Seven arms, every one of them a real outcome. */
export function readDegradedRollback(
  result: RollbackDegradedResult & RollbackDegradedResendOutcome,
): RollbackDispositionReading {
  const shared = {
    disposition: result.disposition,
    settlementClass: "degraded",
    tone: "attention",
    isNonResumable: false,
  } as const;
  switch (result.disposition) {
    case "files-partially-restored":
      return {
        ...shared,
        summary: `The rewind landed in the conversation and the file restore stopped part way, at ${result.failedStep}. Everything applied before that point is listed below.`,
        files: {
          overwrittenIgnoredPaths: result.overwrittenIgnoredPaths,
          divergentGitlinks: result.divergentGitlinks,
        },
        positions: [],
        resendDisposition: result.resendDisposition,
      };
    case "files-unrestored":
      return {
        ...shared,
        summary:
          "The rewind landed in the conversation and no file was restored. The working tree is as it was before the rewind was asked for.",
        files: undefined,
        positions: [],
        resendDisposition: result.resendDisposition,
      };
    case "pause-only":
      return {
        ...shared,
        summary:
          "The run was paused and nothing was rewound. The conversation and the working tree are both unchanged.",
        files: undefined,
        positions: [],
        resendDisposition: result.resendDisposition,
      };
    case "nothing-applied":
      return {
        ...shared,
        summary:
          "Nothing was applied. The run, the conversation, and the working tree are all as they were.",
        files: undefined,
        positions: [],
        resendDisposition: result.resendDisposition,
      };
    case "position-mismatch":
      return {
        ...shared,
        summary:
          "The rewind landed somewhere other than the position it was asked for. Both positions are the daemon's own, shown below so the landing point is legible.",
        files: undefined,
        positions: [
          { label: "Requested", position: result.requestedPosition },
          { label: "Confirmed", position: result.confirmedPosition },
        ],
        resendDisposition: result.resendDisposition,
      };
    case "boundary-diverged":
      return {
        ...shared,
        tone: "failure",
        summary:
          "The rewind crossed a context-compaction boundary. This run is not resumable in V1: a later resume refuses as a standing rule rather than a transient failure.",
        files: undefined,
        positions: [
          { label: "Confirmed", position: result.confirmedPosition },
          { label: "Newest boundary", position: result.newestBoundaryPosition },
        ],
        resendDisposition: result.resendDisposition,
        isNonResumable: true,
      };
    case "resend-unapplied":
      return {
        ...shared,
        summary:
          "The rewind landed and the working tree was restored; the replacement message was not admitted. Your text is not lost — it is held on the intervention record.",
        files: {
          overwrittenIgnoredPaths: result.overwrittenIgnoredPaths,
          divergentGitlinks: result.divergentGitlinks,
        },
        positions: [],
        resendDisposition: result.resendDisposition,
      };
    default:
      return unreachableDisposition(result);
  }
}

/**
 * What the settlement says about the caller's replacement text.
 *
 * `undefined` where the result carries no `resendDisposition`, which is the shape
 * of every bare rollback — the member is schema-optional precisely because no
 * member of a result identifies its request as composite.
 */
export function resendSettlementSentence(
  resendDisposition: "admitted" | "unapplied" | undefined,
): string | undefined {
  if (resendDisposition === "admitted") {
    // Never "sent" and never "re-sent": the composite admits the replacement
    // run-bound and does not dispatch it.
    return "Your replacement message is queued and will send on the next resume.";
  }
  if (resendDisposition === "unapplied") {
    return "Your replacement message was not admitted. It stays recoverable on the intervention record.";
  }
  return undefined;
}

/**
 * The `satisfies never` tail, as a function so both switches share it.
 *
 * A tenth disposition makes the parameter no longer `never` and this call fails to
 * compile at both call sites — which is the whole point, and is strictly stronger
 * than a runtime default that renders a nameless settlement.
 */
function unreachableDisposition(result: never): never {
  const unreadable = result satisfies never;
  throw new Error(
    `the rollback result carried a disposition this console has no reading for: ${JSON.stringify(unreadable)}`,
  );
}
