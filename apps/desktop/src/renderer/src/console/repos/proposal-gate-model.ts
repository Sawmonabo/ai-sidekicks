// The gate reader's pure half: which worktree a gate is about, what a settled arm
// says out loud, and how a wire branch context becomes one the summary can draw.
//
// Split from `proposal-gate-reader.ts` on the seam this family already uses twice —
// `proposal-model.ts` beside `ProposalGate.tsx`, `worktree-model.ts` beside
// `WorktreeCard.tsx`: what a value IS, against the object that fetches and holds it.
// Everything here is a pure function or a closed table, so a test can hold the
// announcement vocabulary and the wire mapping without constructing a reader, a
// bridge, or a clock.
//
// NOTHING HERE CALLS, SCHEDULES, OR HOLDS STATE. The reader owns all three.

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../bridge/index.js";
import type { BranchContextReading } from "./branch-context-model.js";

/**
 * The branch context exactly as the growth port serves it.
 *
 * DERIVED FROM THE PORT rather than imported as a named value type, because the
 * console family barrel publishes the bridge and not the reply vocabulary behind it,
 * and a hand-written mirror of the wire shape here would be a second declaration of a
 * closed set — the failure mode `apps/desktop/AGENTS.md` names outright. Deriving it
 * means a member added to, renamed on, or removed from the registered signature is a
 * compile error in the mapper below rather than a silently dropped field.
 */
type ServedBranchContext = NonNullable<
  Extract<
    Awaited<ReturnType<ConsoleBridge["growth"]["gitflowBranchContextRead"]>>,
    { readonly status: "served" }
  >["value"]["branchContext"]
>;

/** The subsystem every refusal the gate reader mints names as its author. */
export const PROPOSAL_GATE_REFUSAL_ORIGIN = "proposal-gate";

/**
 * Why an act failed on the console's side of the wire.
 *
 * Two members, closed, and neither overlaps a growth-port or a daemon code — those
 * travel verbatim. These name the two failures that are the reader's own to describe:
 * an act pressed with no served context behind it, and an act the daemon answered
 * without accepting.
 */
export const PROPOSAL_GATE_REFUSAL_CODES = ["no-served-context", "action-not-accepted"] as const;

/** One reader-side refusal code. Derived, so the vocabulary is declared exactly once. */
export type ProposalGateRefusalCode = (typeof PROPOSAL_GATE_REFUSAL_CODES)[number];

/** Which worktree's gate this is. One value, so two ids cannot be transposed. */
export interface ProposalGateSubject {
  readonly workspaceId: string;
  readonly worktreeId: string;
  /**
   * The workspace's selected mode, from the mounts reading.
   *
   * Supplied rather than read again: the `no-context` arm has to name the mode that
   * explains the absence, and a second read of it here would be a second source of
   * truth for a fact the section already holds — and could disagree with the row the
   * gate is drawn under.
   */
  readonly executionMode: ExecutionMode;
}

/**
 * Which settled arms are announced, and what each one says.
 *
 * A closed table rather than sentences composed at the four publish sites, so one arm
 * is never announced two ways. `not-checked` has NO entry, deliberately: its sentence
 * is the growth port's own refusal, which names the wire and the document that owes
 * it, and a console sentence beside it would paraphrase a refusal the console did not
 * author — which rule 9 forbids.
 */
export const GATE_SETTLEMENT_COPY: Readonly<Record<AnnouncedGateSettlement, string>> = {
  "no-context": "This workspace has no writable branch context.",
  prepared: "A branch context was read. No proposal has been prepared yet.",
  "prepared-with-proposal": "A branch context and a prepared proposal were read.",
  refused: "The branch context could not be read.",
};

/** The settlements that have a sentence of their own. Declared once, derived above. */
export const ANNOUNCED_GATE_SETTLEMENTS = [
  "no-context",
  "prepared",
  "prepared-with-proposal",
  "refused",
] as const;

/** One announced settlement. Derived, so the vocabulary is declared exactly once. */
export type AnnouncedGateSettlement = (typeof ANNOUNCED_GATE_SETTLEMENTS)[number];

/**
 * Turn the wire's branch context into the shape the summary draws.
 *
 * `workspaceId` is dropped rather than carried: the gate is already mounted under one
 * workspace, and a second copy of that id on a display shape is a value that can
 * disagree with the row it sits in. The three optional members are spread
 * conditionally because `exactOptionalPropertyTypes` makes an explicit `undefined` a
 * different type from an absent member, and the display shape means absent.
 */
export function branchContextReadingFrom(
  branchContext: ServedBranchContext,
  executionMode: ExecutionMode,
): BranchContextReading {
  return {
    branchContextId: branchContext.branchContextId,
    baseBranch: branchContext.baseBranch,
    headBranch: branchContext.headBranch,
    executionMode,
    ...(branchContext.upstreamRef === undefined ? {} : { upstreamRef: branchContext.upstreamRef }),
    ...(branchContext.worktreeId === undefined ? {} : { worktreeId: branchContext.worktreeId }),
    ...(branchContext.ephemeralCloneId === undefined
      ? {}
      : { ephemeralCloneId: branchContext.ephemeralCloneId }),
  };
}
