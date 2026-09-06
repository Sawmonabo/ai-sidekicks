// What a settled rollback says: the nine dispositions, and the refusal that has none.
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
//
// AND THE REFUSAL THAT CARRIES NO DISPOSITION. A rollback rejected by one of the
// composite's four structural guards settles `rejected` with a `rejectionReason` and
// no `result` at all, so none of the reading above reaches it. That arm is the second
// half of this module, below.

import type {
  RollbackAppliedResendOutcome,
  RollbackAppliedResult,
  RollbackDegradedResendOutcome,
  RollbackDegradedResult,
} from "@ai-sidekicks/contracts";
import type { ChipTone } from "../../../primitives/index.js";

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

// --------------------------------------------------------------------------
// The four structural guards, and what a person does about each
// --------------------------------------------------------------------------
//
// An edit-and-resend is refused whole by four checks, each fail-closed at admission
// and pre-dispatch (`Spec-004 §Required Behavior`): no active turn, no pending send,
// a participant-authored target boundary of this run, and a resumable target. Each
// refuses for a different reason and each leaves the participant a different next
// move, and until this reading existed the console showed one wire string and no move
// at all — which is worst for the pending-send guard, whose remedy is an act the
// person has to perform (cancel the queued items, or let them drain) before the same
// request can ever succeed.
//
// IT IS RECOGNISED FROM THE DAEMON'S OWN REASON, AND NEVER DERIVED. The renderer
// projects no eligibility: it does not decide which guard SHOULD have refused from
// the run state it holds, because that is the daemon's decision and a second copy of
// it would disagree the first time the two read a run differently. What this reading
// does is recognise which check the daemon SAID refused.
//
// AND IT RECOGNISES A PHRASE RATHER THAN A TOKEN, because there is no token to key
// on: `rejectionReason` is registered as a free-form `string`
// (`api-payload-contracts.md`), and no closed union for these four is registered
// anywhere in the corpus. An exact table would therefore have to guess the daemon's
// spelling and would silently answer `undefined` for every near-miss. So the match is
// containment of the spec's OWN name for the check — "pending send", "active turn",
// "participant authored", "resumable" — over a reason normalized to lowercase
// hyphens, which is robust across `no_pending_send`, `composite.pendingSend`, and a
// plain English sentence alike. The phrases are disjoint, so the scan order decides
// nothing.
//
// A REASON NAMING NONE OF THEM READS EXACTLY AS IT DOES WITHOUT THIS: the daemon's
// own string, verbatim, with no move beside it. Answering `undefined` is the honest
// result for a refusal that is not one of these four — a bare rollback's
// `driver.capability_unsupported` among them — and inventing a nearest guard for it
// would be the console telling a person to drain a queue that has nothing in it.

/** One of the four structural checks an edit-and-resend is refused whole by. */
export type CompositeRefusalGuard =
  | "no-active-turn"
  | "no-pending-send"
  | "participant-authored-boundary"
  | "resumable-target";

/** What one guard refused, and the act that clears it. */
export interface CompositeGuardReading {
  readonly guard: CompositeRefusalGuard;
  /** What this check refuses, in the console's words — never the daemon's sentence. */
  readonly refused: string;
  /** The participant's next move, which for two of the four is a real act. */
  readonly remedy: string;
}

/** A guard, plus the spec's own names for it that a reason may carry. */
interface CompositeGuardEntry extends CompositeGuardReading {
  readonly namedBy: readonly string[];
}

const COMPOSITE_GUARDS: readonly CompositeGuardEntry[] = [
  {
    guard: "no-active-turn",
    namedBy: ["active-turn"],
    refused:
      "The run is still answering the message you corrected. The rewind was refused outright rather than pausing a live turn to rewrite the prompt it is working from.",
    remedy: "Pause or stop the run first, then correct the message again.",
  },
  {
    guard: "no-pending-send",
    namedBy: ["pending-send", "queued-send"],
    refused:
      "An earlier send is still pending on this run — accepted and not yet delivered, or queued and not yet drained — and it would reach the provider ahead of your correction.",
    remedy:
      "Cancel the queued items, or let them drain, and then send the correction again. Nothing here reorders the queue on your behalf.",
  },
  {
    guard: "participant-authored-boundary",
    namedBy: ["participant-authored", "orchestration-authored"],
    refused:
      "The boundary you targeted was not opened by a participant message of this run, so there is no participant send to replace. A workflow phase input and an orchestrated child run both land here.",
    remedy:
      "Rewind to that boundary without a correction, and change the input where it was authored.",
  },
  {
    guard: "resumable-target",
    namedBy: ["resumable", "rootless"],
    refused:
      "This run can never resume — its execution context is released with no working root — so a correction queued against it would never be delivered.",
    remedy:
      "Rewind without a correction to keep the history, then start a fresh run on the same branch carrying the corrected text.",
  },
];

/**
 * Which structural guard the daemon's reason names, where it names one.
 *
 * `undefined` for every reason that names none, which is the whole of what the
 * console can honestly say about a refusal it does not recognise.
 */
export function compositeGuardReading(rejectionReason: string): CompositeGuardReading | undefined {
  // The camel-case split runs BEFORE the lowercase, because after it there is no
  // boundary left to split on and `pendingSend` would normalize to one word that
  // contains no phrase at all.
  const normalized = rejectionReason
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const matched = COMPOSITE_GUARDS.find((entry) =>
    entry.namedBy.some((phrase) => normalized.includes(phrase)),
  );
  if (matched === undefined) {
    return undefined;
  }
  return { guard: matched.guard, refused: matched.refused, remedy: matched.remedy };
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
