// The run controls' vocabulary: the two actions, what a dispatched act can have got
// to, and the two refusals this surface can raise on its own.
//
// WHY A MODULE RATHER THAN PROPS ON THE COMPONENT. Three of the four things below
// are CLOSED SETS — the actions, the refusal codes, the states a served reply may
// answer with — and a closed set spelled inside a component is a set the next
// surface re-spells. The fourth, the reason bound, is NOT here at all: a number with
// a rationale has one home for the whole console, and `cap-constant-home.test.ts`
// fails a view family that declares one of its own — so this module spends
// `WORKFLOW_CANCEL_REASON_BYTE_CAP` through the core family's door and declares
// nothing about it.
//
// ELIGIBILITY IS NEVER COMPUTED HERE, AND THAT IS WHY THERE IS NO REFUSED CONTROL.
// Whether a run may be cancelled or resumed is a daemon adjudication reaching the
// console as a typed refusal — `workflow.control_denied` on either of the two
// separately grantable actions, `workflow.run_not_cancellable` on a run that reached
// a terminal, `workflow.resume_not_parked` and the repair codes on resume. Nothing in
// this console can know any of that before it asks. So a control is OFFERED, its
// press puts the question, and the answer lands on {@link WorkflowRunControlOutcome}
// beside the button that asked it — rule 9's shape exactly: nothing changed, the act
// did not happen, and the control stays beside its refusal. A pre-press `refused`
// arm would have had to be composed by a caller that had adjudicated nothing, which
// is how this surface came to claim its wire was missing while the port carried it.
//
// THE TWO REFUSALS THIS FAMILY RAISES ITSELF are the reason bound and a second press
// while the first is still in flight, and both are raised BEFORE a call rather than
// instead of one. An operator's cancellation reason past the bound would be rejected
// at the far end, and refusing it here — loudly, with the budget visible — is the
// difference between a control that explains itself and one that fails after the
// operator has committed. A second press is refused for the opposite reason: the
// first call is still outstanding, a queue would perform an act nobody re-confirmed
// against a run whose state has moved, and dropping it silently is a button that
// looks broken.
//
// WIRE STATUS — READ THIS BEFORE WIRING A CALLER. `packages/contracts` registers no
// `workflow.*` method, so both controls travel the growth port instead:
// `bridge/growth-operations/workflows.ts` carries `workflowRunCancel` and
// `workflowRunResume` on the `workflow-run-control` slate row, and
// `bridge/growth-port.ts` composes the `wire-unregistered` refusal for a build whose
// bridge cannot serve them. That refusal is the PORT's and is never composed here: a
// mount site that built its own would be asserting a wire fact it had not checked,
// and the port's own builder is unreachable from outside `bridge/` by construction.

import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import type { GrowthPort } from "../../../bridge/index.js";
// The console's one byte measurement, through the family door that publishes it.
// This surface bounds a cancellation reason exactly as the durable path bounds a
// record, and `apps/desktop/AGENTS.md` §Chokepoints gives that one function: a
// second one here agreed on ASCII and would have drifted on the first rule either
// grew.
import { measureUtf8ByteLength } from "../../../persistence/index.js";
import { WORKFLOW_CANCEL_REASON_BYTE_CAP } from "../../../core/index.js";

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
 * `workflow.*` code arrives from the daemon already formed and is rendered verbatim,
 * and the unregistered-wire code is the growth port's own. These two are the cases
 * where there is no daemon in the loop at all — an input this surface can measure
 * before it spends anyone's round trip, and a press it can see is a duplicate of one
 * already outstanding.
 *
 * A UNION AND NOT AN EXPORTED TUPLE, unlike the actions above, and the difference is
 * that the actions array is READ — the surface renders a control per member — while
 * nothing ever read this one. It was published all the same, which is how a second
 * surface comes to restate the literals rather than import them; and a value whose
 * only reader is `typeof` is dead weight at runtime, which is the reason
 * `run-list-rows.ts` gives for its own type-over-value choice.
 */
export type WorkflowRunControlRefusalCode = "reason-past-bound" | "act-already-in-flight";

/**
 * The served arm of whatever outcome one growth operation answers with.
 *
 * A conditional rather than `Extract<…>["value"]`, which does not compile: over an
 * unresolved generic the extraction is not yet known to carry a `value` member at all,
 * so the member is inferred out of the matching arm instead.
 */
type ServedGrowthValue<TOutcome> = TOutcome extends {
  readonly status: "served";
  readonly value: infer TValue;
}
  ? TValue
  : never;

/**
 * What a served `workflow.runCancel` answers with, taken from the port's signature.
 *
 * DERIVED AND NEVER RESTATED. The reply narrows the run union to the outcomes this
 * operation can actually reach, and a hand-written copy of that narrowing is a second
 * wire vocabulary that agrees until the operation's own `Extract` moves. This module
 * reaches for the port's TYPE only; it calls nothing.
 */
export type WorkflowRunCancelReply = ServedGrowthValue<
  Awaited<ReturnType<GrowthPort["workflowRunCancel"]>>
>;

/** What a served `workflow.runResume` answers with, on the same derivation. */
export type WorkflowRunResumeReply = ServedGrowthValue<
  Awaited<ReturnType<GrowthPort["workflowRunResume"]>>
>;

/** Every run state either control's served reply can report, and no others. */
export type WorkflowRunControlRunState =
  | WorkflowRunCancelReply["state"]
  | WorkflowRunResumeReply["state"];

/**
 * Where one control's dispatched act has got to, for the run it was pressed on.
 *
 * FOUR ARMS BECAUSE FOUR THINGS ARE TRUE AT DIFFERENT MOMENTS and none of them is
 * another: nothing has been pressed, a call is out, an answer came back, or the act
 * was refused. `idle` is not "it succeeded and there is nothing to say", and
 * `dispatching` is not a settlement — a control that collapsed either into the other
 * would be reporting an act that had not happened.
 *
 * There is deliberately no optimistic arm. Nothing here mutates the run the pane is
 * rendering: what a person sees change is what the daemon answered, which is the
 * whole of `Spec-023 §Console Design (Meridian)` rule 9.
 */
export type WorkflowRunControlOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "dispatching" }
  | {
      readonly kind: "settled";
      /** The run state the reply answered with, wire-verbatim and never paraphrased. */
      readonly runState: WorkflowRunControlRunState;
      /** What that state means for the operator, in this console's own words. */
      readonly detail: string;
    }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The outcome a control stands at before anything has been pressed on this run. */
export const IDLE_RUN_CONTROL_OUTCOME: WorkflowRunControlOutcome = { kind: "idle" };

/**
 * The state a resume answers with when the run re-parks on its next dispatch.
 *
 * ONE HOME BECAUSE TWO SURFACES NAME IT. The resume control warns about this outcome
 * before the press, and the dispatcher reads the reply to decide which sentence the
 * settlement carries after it — two literals of one wire word, and the pair is
 * exactly how a console comes to warn about a state it no longer recognises.
 * Annotated with the derived union, so a word this reply cannot answer with is a
 * compile error rather than a warning about nothing.
 */
export const WORKFLOW_RUN_RE_PARKED_STATE: WorkflowRunControlRunState = "suspended";

/** What the operator has spent of the reason budget, and whether they are past it. */
export interface CancelReasonBudget {
  readonly byteLength: number;
  /** Bytes still available. Zero rather than negative once the bound is passed. */
  readonly remainingBytes: number;
  readonly isPastBound: boolean;
}

/** Measure a reason against the bound. Pure; the caller decides what to do about it. */
export function cancelReasonBudget(reason: string): CancelReasonBudget {
  const byteLength = measureUtf8ByteLength(reason);
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

/** What each action is called where a person reads a sentence about it. */
const ACTION_PROSE: Readonly<Record<WorkflowRunControlAction, string>> = {
  cancel: "Cancelling a run",
  resume: "Resuming a run",
};

/**
 * The refusal a second press earns while the first call is still outstanding.
 *
 * REFUSED AND NEVER QUEUED, and never dropped either. Queued, the second press would
 * perform an act nobody re-confirmed against a run whose state the first call has by
 * then moved; dropped, the operator presses a button that does nothing and is told
 * nothing, which is the one failure rule 9 exists to prevent. So the press is
 * answered, in the control's own body, with the fact that the run already has this
 * act in flight.
 *
 * "In flight" and never "denied": no question was put to a daemon by this press at
 * all, so a console that rendered it as an adjudication would be asserting one that
 * never happened.
 */
export function actAlreadyInFlightRefusal(action: WorkflowRunControlAction): ConsoleRefusal {
  const code: WorkflowRunControlRefusalCode = "act-already-in-flight";
  return refuse(
    WORKFLOW_RUN_CONTROL_ORIGIN,
    code,
    `${ACTION_PROSE[action]} is already in flight for this run. Wait for the answer; a second press is not queued.`,
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

/** What a cancel control is: the call, and where the last press of it got to. */
export interface WorkflowCancelControl {
  /** `undefined` when the operator gave no reason, which is a legal cancel. */
  readonly cancel: (reason: string | undefined) => void;
  readonly outcome: WorkflowRunControlOutcome;
}

/**
 * What a resume control's DISPATCHER composes: the call, and where the last press of
 * it got to.
 *
 * SEPARATE FROM THE CONTROL BELOW BECAUSE THE CHAIN COMES FROM SOMEWHERE ELSE. The
 * dispatcher puts the call and reads the answer; the chain is a second read, addressed
 * by the version the run's own snapshot reports — and that snapshot's round is the
 * dispatcher's own output, so a dispatcher that also took the chain would close a
 * cycle through itself. Two interfaces, one per producer, and the surface that mounts
 * both is where they meet.
 */
export interface WorkflowResumeDispatch {
  readonly resume: (repin: WorkflowVersionRepin | undefined) => void;
  readonly outcome: WorkflowRunControlOutcome;
}

/** What a resume control is, plus the chain a re-pin may choose from. */
export interface WorkflowResumeControl extends WorkflowResumeDispatch {
  /**
   * The version chain, as the caller read it. Empty means no chain was read,
   * so no target can be named explicitly and the re-pin control is ABSENT —
   * not a disabled picker, and never a silent "latest".
   */
  readonly versionChain: readonly WorkflowVersionChoice[];
}
