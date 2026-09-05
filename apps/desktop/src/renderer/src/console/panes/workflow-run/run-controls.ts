// The run controls' vocabulary: the two actions, what the console may know about
// each, and the two refusals this surface can raise on its own.
//
// WHY A MODULE RATHER THAN PROPS ON THE COMPONENT. Three of the four things below
// are CLOSED SETS — the actions, the refusal codes, the shape a re-pin takes — and
// a closed set spelled inside a component is a set the next surface re-spells. The
// fourth, the reason bound, is a number with a rationale, which belongs beside the
// code that spends it (`console/core/constants.ts` says so in its own header: a
// view family adds its own module rather than widening that one).
//
// ELIGIBILITY IS NEVER COMPUTED HERE, AND THAT IS THE POINT OF THE STATE UNION.
// Whether a run may be cancelled or resumed is a daemon adjudication reaching the
// console as a typed refusal — `workflow.control_denied` on either of the two
// separately grantable actions, `workflow.run_not_cancellable` on a run that
// reached a terminal, `workflow.resume_not_parked` and the repair codes on resume.
// So a control arrives in exactly one of two states: ADMITTED, carrying the call
// its caller supplied, or REFUSED, carrying the refusal verbatim. There is no
// third arm in which the renderer decided, and no boolean anywhere that a surface
// could compute from a run's status.
//
// THE ONE REFUSAL THIS FAMILY RAISES ITSELF is the reason bound, and it is raised
// BEFORE a call rather than instead of one: an operator's cancellation reason past
// the bound would be rejected at the far end, and refusing it here — loudly, with
// the budget visible — is the difference between a control that explains itself and
// one that fails after the operator has committed.
//
// WIRE STATUS — READ THIS BEFORE WIRING A CALLER. `packages/contracts` registers no
// `workflow.*` method and `console/bridge/growth-port.ts` carries no workflow
// operation, so nothing in this console can call the run controls at all today. The
// slate's two workflow rows (`workflow-event-registration`,
// `workflow-definition-scope`) cover the event taxonomy and a definition-scope type
// meaning, not these operations. `unregisteredRunControl` below is what a caller
// that has no wire hands the controls, and it renders as the honest absence rather
// than as a dead button.

import { refuse, type ConsoleRefusal } from "../../core/index.js";

/**
 * The two run controls, and exactly two.
 *
 * They are separately grantable — a principal may hold one and not the other, and
 * the daemon's denial names which — so they are enumerated rather than implied by
 * the two members of the props type. The tuple is the declaration and the union
 * derives from it, so a third control is one edit a reviewer sees.
 */
export const WORKFLOW_RUN_CONTROL_ACTIONS = ["cancel", "resume"] as const;

/** One run control. Derived from the tuple, never restated. */
export type WorkflowRunControlAction = (typeof WORKFLOW_RUN_CONTROL_ACTIONS)[number];

/** The subsystem name every refusal raised in this file carries. */
export const WORKFLOW_RUN_CONTROL_ORIGIN = "workflow-run-control";

/**
 * The refusals this surface raises on its own, and no others.
 *
 * Deliberately short and deliberately not the daemon's vocabulary: every
 * `workflow.*` code arrives from the daemon already formed and is rendered
 * verbatim. These two are the cases where there is no daemon in the loop at all —
 * a wire that does not exist, and an input this surface can measure before it
 * spends anyone's round trip.
 *
 * A UNION AND NOT AN EXPORTED TUPLE, unlike the actions above, and the difference is
 * that the actions array is READ — the surface renders a control per member — while
 * nothing ever read this one. It was published all the same, which is how a second
 * surface comes to restate the literals rather than import them; and a value whose
 * only reader is `typeof` is dead weight at runtime, which is the reason
 * `run-list-rows.ts` gives for its own type-over-value choice.
 */
export type WorkflowRunControlRefusalCode = "wire-unregistered" | "reason-past-bound";

/**
 * Bytes a cancellation reason may occupy, bounded exactly as the engine's own park
 * cause is: eight kibibytes, measured on the UTF-8 encoding rather than on the
 * string's length, because a bound counted in code units refuses a shorter sentence
 * in one script than in another.
 *
 * The unit is spelled out rather than abbreviated on purpose — the console's
 * byte-scaling chokepoint is asserted by scanning every source module for a binary
 * unit LABEL, and a comment carrying one would read as a second byte formatter.
 * Multiplying up to a bound is not scaling down to a display figure.
 */
export const WORKFLOW_CANCEL_REASON_BYTE_CAP: number = 8 * 1024;

/**
 * How many bytes a string occupies once encoded.
 *
 * The console's first byte MEASUREMENT — `primitives/wire-figures.ts` formats byte
 * figures and measures none, and `persistence/` caps a serialised value by its
 * JSON length. A second one is a hoist, not a copy: it moves down to the lowest
 * family that needs it the moment a second module does.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** What the operator has spent of the reason budget, and whether they are past it. */
export interface CancelReasonBudget {
  readonly byteLength: number;
  /** Bytes still available. Zero rather than negative once the bound is passed. */
  readonly remainingBytes: number;
  readonly isPastBound: boolean;
}

/** Measure a reason against the bound. Pure; the caller decides what to do about it. */
export function cancelReasonBudget(reason: string): CancelReasonBudget {
  const byteLength = utf8ByteLength(reason);
  return {
    byteLength,
    remainingBytes: Math.max(0, WORKFLOW_CANCEL_REASON_BYTE_CAP - byteLength),
    isPastBound: byteLength > WORKFLOW_CANCEL_REASON_BYTE_CAP,
  };
}

/**
 * The refusal a reason past the bound earns.
 *
 * Names the bound and never the value: the reason is participant content, and
 * `core/refusal.ts` fixes `detail` as one actionable sentence that is never the
 * refused value itself.
 */
export function reasonPastBoundRefusal(budget: CancelReasonBudget): ConsoleRefusal {
  // Bound through the closed vocabulary before it reaches `refuse`, whose `code`
  // parameter is a deliberately-wide `string` — `core/refusal.ts` cannot close it
  // without importing every producer and inverting the DAG. The annotation is what
  // keeps this producer inside its own declared set.
  const code: WorkflowRunControlRefusalCode = "reason-past-bound";
  return refuse(
    WORKFLOW_RUN_CONTROL_ORIGIN,
    code,
    `The reason is ${String(budget.byteLength)} bytes and the engine accepts ${String(WORKFLOW_CANCEL_REASON_BYTE_CAP)}. Shorten it, or cancel without one.`,
  );
}

/** What each action is called where a person reads about it not being reachable. */
const ACTION_PROSE: Readonly<Record<WorkflowRunControlAction, string>> = {
  cancel: "Cancelling a run",
  resume: "Resuming a run",
};

/**
 * The state a control is in on a build whose bridge does not carry its operation.
 *
 * "Not checked" and never "denied": nobody put the question to a daemon, so a
 * console that rendered this as a denial would be asserting an adjudication that
 * never happened. The detail says which act is unreachable in prose rather than
 * naming a method string, because no such method is registered and printing one
 * would be this surface inventing the wire it is reporting the absence of.
 */
export function unregisteredRunControl(action: WorkflowRunControlAction): ConsoleRefusal {
  const code: WorkflowRunControlRefusalCode = "wire-unregistered";
  return refuse(
    WORKFLOW_RUN_CONTROL_ORIGIN,
    code,
    `${ACTION_PROSE[action]} is not reachable from this build — the operation is not on the bridge yet.`,
  );
}

/** One version a resume may re-pin onto, as the caller resolved it from the chain. */
export interface WorkflowVersionChoice {
  /** Opaque and wire-verbatim. Passed through, never parsed. */
  readonly workflowVersionId: string;
  /** What a person reads instead of the id — the caller's, never derived here. */
  readonly label: string;
  /** True for the version the run is pinned to now. */
  readonly isCurrentPin: boolean;
}

/**
 * The re-pin a resume carries, when it carries one.
 *
 * `targetWorkflowVersionId` is required WITHIN the member and the member itself is
 * optional, which is the whole shape: a resume either re-pins onto a version the
 * operator named or it does not re-pin at all. There is deliberately no "latest"
 * — a server-resolved latest would race the definition's own edits and leave the
 * audited from-and-to pair unverifiable against what the operator saw.
 */
export interface WorkflowVersionRepin {
  readonly targetWorkflowVersionId: string;
}

/** What a cancel control is: the call, or the refusal that stands in its place. */
export type WorkflowCancelControl =
  | {
      readonly kind: "admitted";
      /** `undefined` when the operator gave no reason, which is a legal cancel. */
      readonly cancel: (reason: string | undefined) => void;
    }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** What a resume control is, plus the chain a re-pin may choose from. */
export type WorkflowResumeControl =
  | {
      readonly kind: "admitted";
      readonly resume: (repin: WorkflowVersionRepin | undefined) => void;
      /**
       * The version chain, as the caller read it. Empty means no chain was read,
       * so no target can be named explicitly and the re-pin control is ABSENT —
       * not a disabled picker, and never a silent "latest".
       */
      readonly versionChain: readonly WorkflowVersionChoice[];
    }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };
