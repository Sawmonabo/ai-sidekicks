// What one port outcome becomes before the gate publishes it.
//
// Nothing here CALLS the port, holds a subscription, or owns a timer:
// `proposal-gate-reader.ts` sequences the read and this module answers the one
// question that read asks twice — given what came back, what does the gate now say?
// On the artifact side `repos/artifact-pane/artifact-pane-reading.ts` draws the same
// line for the same reason, and it is the reason both files are small: a composer
// with no state can be driven by a test with no bridge, no clock, and no scheduler.
//
// BOTH COMPOSERS TAKE THE STANDING READING AND RETURN A WHOLE ONE. They spread the
// previous reading rather than patching fields into it, so every member a new arm does
// not set is carried forward explicitly and none is left holding a value from the arm
// before it — which is the defect the `refusal: undefined` on each served arm exists
// to prevent, stated once here instead of at each call site.

import type { ConsoleRefusal } from "../../core/index.js";
import type { BranchContextReading } from "../mounts/branch-context-model.js";

import type { PreparedProposal } from "./prepared-proposal.js";
import { GATE_SETTLEMENT_COPY, type ProposalGateReading } from "./proposal-gate-model.js";

/**
 * What a refused read says, on the arm its refusal class earns.
 *
 * THE PORT'S REFUSAL CLASSES ARE TWO DIFFERENT FACTS AND GET TWO DIFFERENT ARMS, and
 * the split is on whether the question was PUT. `wire-unregistered` says it could not
 * be — this build carries no such wire — which is `not-checked`, and that arm carries
 * no message, so the refusal travels beside it. Every other member says the question
 * was put and no usable answer came: a scripted reply the frozen clock never released,
 * and a `call-rejected` whose call was made and threw. Those are failures, and the
 * `refused` arm states each in the words its own producer wrote.
 *
 * SO THE PREDICATE NAMES THE ONE MEMBER RATHER THAN LISTING THE REST, which is what
 * keeps a fifth code on the right arm the day the port declares one: an unregistered
 * wire is the only refusal that is not a failure, and everything else defaults to the
 * arm that says something went wrong.
 *
 * TAKES THE CONSOLE'S ONE REFUSAL SHAPE RATHER THAN THE PORT'S WIDENING, because this
 * gate renders a `ConsoleRefusal` and reads only `code` and `detail`. Both of the arms
 * above are reached with a `GrowthUnavailable` today — `repos/growth-call.ts` hands
 * every rejected call to the port's own builder — and narrowing the parameter to that
 * widening would buy nothing here and refuse a bare refusal a caller may still hold.
 */
export function gateReadingForRefusal(
  previous: ProposalGateReading,
  refusal: ConsoleRefusal,
): ProposalGateReading {
  if (refusal.code === "wire-unregistered") {
    return {
      ...previous,
      state: { kind: "not-checked" },
      refusal,
      settlement: refusal.detail,
    };
  }
  return {
    ...previous,
    state: { kind: "refused", message: refusal.detail },
    refusal: undefined,
    settlement: GATE_SETTLEMENT_COPY.refused,
  };
}

/**
 * What a served read says, with the proposal this context still admits.
 *
 * The proposal is passed rather than reached for: whether the held one survived a
 * context change is the reader's decision — it owns the key it was prepared against —
 * and by the time it calls this the answer is already `undefined` or a proposal that
 * belongs to exactly this context. Two settlements rather than one, because a gate
 * offering a remote act reads differently from one that is merely ready.
 */
export function gateReadingForContext(
  previous: ProposalGateReading,
  context: BranchContextReading,
  proposal: PreparedProposal | undefined,
): ProposalGateReading {
  return {
    ...previous,
    state: {
      kind: "prepared",
      context,
      ...(proposal === undefined ? {} : { proposal }),
    },
    refusal: undefined,
    settlement:
      proposal === undefined
        ? GATE_SETTLEMENT_COPY.prepared
        : GATE_SETTLEMENT_COPY["prepared-with-proposal"],
  };
}
