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
 * THE PORT'S TWO REFUSAL CLASSES ARE TWO DIFFERENT FACTS AND GET TWO DIFFERENT ARMS.
 * `wire-unregistered` means the question could not be put at all, which is
 * `not-checked` — and that arm carries no message, so the refusal travels beside it.
 * A scripted reply that never arrived means the question WAS put and the answer did
 * not come, which is a failure the `refused` arm states in the daemon's own words.
 *
 * TAKES THE CONSOLE'S ONE REFUSAL SHAPE RATHER THAN THE PORT'S WIDENING, because the
 * read now reaches it through `repos/growth-call.ts`: a REJECTED call becomes a refusal
 * carrying the port's origin and `wire-unregistered` without ever having been a
 * `GrowthUnavailable`, and it is the same fact — the namespace the call goes through is
 * gone, so the question could not be put. Narrowed to the widening, that answer could
 * not be handed here at all.
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
