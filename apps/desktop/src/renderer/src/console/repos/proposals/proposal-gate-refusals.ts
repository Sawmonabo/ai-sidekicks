// What a refused act leaves beside the control that produced it — the sentences the
// gate authors, and the two writes that put one on the gate or take it off.
//
// A MODULE OF ITS OWN BECAUSE BOTH LEGS AND THE ADMISSION PATH ALL WRITE THE SAME WAY.
// `proposal-gate-actions.ts` refuses before it sends (a second act in flight, a gate
// with no served context), while it sends (a context the gate has since re-read), and
// after it sends (a served answer the daemon did not take) — and every one of those is
// the same write onto `actionRefusals` keyed by the act pressed. Three copies of that
// write would be three chances for one of them to drop the key, publish onto the arm, or
// forget that a refusal is per-act.
//
// FUNCTIONS OVER THE HOST, NOT METHODS ON THE ACTS, on `artifact-action-host.ts`'s
// reason one directory over: the write is a reduction over the reading like the ones
// beside it, and it needs exactly the two operations the host already names.
//
// THE SENTENCES ARE HERE BECAUSE THE CODES ARE. Each one names a
// `ProposalGateRefusalCode` and says, in a person's words, what was and was not sent.
// Written at the call sites, a code and its sentence could drift apart — and rule 9
// forbids paraphrasing a refusal the console did not author, which is why the
// daemon's own `error` is carried verbatim and the console's sentence is only the
// fallback for a reply that failed and named no reason.

import { normalizeWireRejection, refuse, type ConsoleRefusal } from "../../core/index.js";
import { PROPOSAL_ACTION_PRESENTATION, type ProposalAction } from "./proposal-actions.js";
import type { ProposalGateActionHost } from "./proposal-gate-action-host.js";
import {
  PROPOSAL_GATE_REFUSAL_ORIGIN,
  type ProposalGateRefusalCode,
} from "./proposal-gate-model.js";

/**
 * A second act pressed while one is unanswered.
 *
 * Names the act the gate is actually waiting on, not the one pressed: a participant
 * told "something is in flight" cannot tell what.
 */
export function actionInFlightRefusal(pending: ProposalAction): ConsoleRefusal {
  return refuse(
    PROPOSAL_GATE_REFUSAL_ORIGIN,
    "action-in-flight" satisfies ProposalGateRefusalCode,
    `${PROPOSAL_ACTION_PRESENTATION[pending].label} has been sent and the daemon has not answered yet. Nothing else is sent until it settles.`,
  );
}

/** An act pressed on a gate that has read no context. Structurally unreachable, and stated anyway. */
export function noServedContextRefusal(): ConsoleRefusal {
  return refuse(
    PROPOSAL_GATE_REFUSAL_ORIGIN,
    "no-served-context" satisfies ProposalGateRefusalCode,
    "This gate has read no branch context, so there is nothing to act on.",
  );
}

/** An act admitted against a context the gate has since read again. Nothing was sent. */
export function contextSupersededRefusal(action: ProposalAction): ConsoleRefusal {
  return refuse(
    PROPOSAL_GATE_REFUSAL_ORIGIN,
    "context-superseded" satisfies ProposalGateRefusalCode,
    `${PROPOSAL_ACTION_PRESENTATION[action].label} was pressed against a branch context this gate has since read again, so nothing was sent against it.`,
  );
}

/**
 * A served answer that did not take the act.
 *
 * The reply's OWN `error` stands here when it carries one, verbatim; the console's
 * sentence is the fallback for a reply that failed and said why nowhere, and it claims
 * nothing about the reason.
 */
export function actionNotAcceptedRefusal(
  action: ProposalAction,
  reportedError: string | undefined,
): ConsoleRefusal {
  return refuse(
    PROPOSAL_GATE_REFUSAL_ORIGIN,
    "action-not-accepted" satisfies ProposalGateRefusalCode,
    reportedError ??
      `The daemon answered this action without taking it, and named no reason. Nothing was ${action === "commit" ? "recorded" : "sent"}.`,
  );
}

/**
 * A preparation the daemon served in a state this console has no reading for.
 *
 * The received word is carried verbatim and quoted, because the participant's next
 * question is which state came back — and paraphrasing it would be the console
 * describing a value it did not author. Nothing was sent: preparation is the step
 * before any remote mutation, so the honest sentence says the proposal was not held
 * rather than that an act failed.
 */
export function preparedStateUnreadableRefusal(receivedState: unknown): ConsoleRefusal {
  return refuse(
    PROPOSAL_GATE_REFUSAL_ORIGIN,
    "prepared-state-unreadable" satisfies ProposalGateRefusalCode,
    `The daemon prepared this proposal in a state this console has no reading for (${JSON.stringify(receivedState)}), so it was not held. Nothing was sent.`,
  );
}

/** Put one act's failure on the gate, beside the control that produced it. */
export function recordActionRefusal(
  host: ProposalGateActionHost,
  action: ProposalAction,
  refusal: ConsoleRefusal,
): void {
  const reading = host.currentReading();
  const actionRefusals = new Map(reading.actionRefusals);
  actionRefusals.set(action, refusal);
  host.publish({ ...reading, actionRefusals });
}

/** Drop one act's standing failure. A publish only where there was one to drop. */
export function clearActionRefusal(host: ProposalGateActionHost, action: ProposalAction): void {
  const reading = host.currentReading();
  if (!reading.actionRefusals.has(action)) {
    return;
  }
  const actionRefusals = new Map(reading.actionRefusals);
  actionRefusals.delete(action);
  host.publish({ ...reading, actionRefusals });
}

/**
 * A read that failed PAST its own refusal handling, in the gate's own words.
 *
 * NOT A REJECTED CALL, and that is the whole reason it is the gate's. The branch-context
 * read goes through `repos/growth-call.ts`, so a rejection is already an answer carrying
 * the growth port's origin and its own `call-rejected` before the scheduler sees it.
 * What reaches the scheduler's `onError` is this reader failing afterwards — mapping a
 * served reply, or a sink that threw — and the stamp that stood here named the family's
 * DAEMON reads, a subsystem this leg never asks.
 *
 * NORMALIZED RATHER THAN STRINGIFIED, on `repos/repo-reads.ts`'s reason: a scripted or
 * live rejection arrives as the wire's `{ code, message }` envelope, which is not an
 * `Error`, so a bare `String(error)` printed `[object Object]` on exactly the path that
 * carries "this workspace has no branch context". The rejected value is never quoted
 * into the console's own fallback sentence.
 */
export function gateReadFailureRefusal(leg: string, error: unknown): ConsoleRefusal {
  return normalizeWireRejection(PROPOSAL_GATE_REFUSAL_ORIGIN, error, {
    code: "read-threw" satisfies ProposalGateRefusalCode,
    detail: `${leg} failed before it could answer.`,
  });
}
