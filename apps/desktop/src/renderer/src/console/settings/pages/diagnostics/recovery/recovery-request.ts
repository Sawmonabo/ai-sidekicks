// What a recovery request settles into, and the one place it is settled.
//
// The recovery request is the diagnostics plane's only mutation, and its reply is a
// RECEIPT rather than an acknowledgement: it carries the state the run was in and the
// state it is in now, which together are the only evidence anything happened. So the
// outcome this module answers is total over what a person can be shown afterwards —
// the receipt, the refusal, or the request still being in flight — and nothing on the
// page re-reads the run to work out which.
//
// A MODULE RATHER THAN A COMPONENT BODY, because it is the seam where a rejection
// becomes a refusal, and that conversion has exactly one correct shape in this console:
// `settleGrowthRead` for the outcome union's own arms plus the scripted and live
// rejection the union has no arm for. A component doing it inline is how a page ends
// up with two refusal vocabularies for one seam.

import {
  settleGrowthRead,
  type ConsoleBridge,
  type GrowthRecoveryAction,
  type GrowthRecoveryReceipt,
} from "../../../../bridge/index.js";
import type { ConsoleRefusal } from "../../../../core/index.js";

/** What the prompt has to show. Total; every arm renders something. */
export type RecoveryOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly action: GrowthRecoveryAction }
  | {
      readonly kind: "settled";
      readonly action: GrowthRecoveryAction;
      readonly receipt: GrowthRecoveryReceipt;
    }
  | {
      readonly kind: "refused";
      readonly action: GrowthRecoveryAction;
      readonly refusal: ConsoleRefusal;
    };

/** The outcome a prompt starts in and returns to when its run is re-addressed. */
export const IDLE_RECOVERY_OUTCOME: RecoveryOutcome = { kind: "idle" };

/**
 * Put one recovery request and read its settlement.
 *
 * Never throws. Both failure shapes the seam has — the port's `unavailable` outcome
 * for a wire the corpus has not registered, and a rejection carrying the daemon's own
 * envelope — arrive as the `refused` arm carrying the refuser's own code and sentence,
 * which is what the section's "refusals are rendered on the control that raised them"
 * requires the caller to have in hand.
 */
export async function requestRecovery(
  bridge: ConsoleBridge,
  runId: string,
  action: GrowthRecoveryAction,
): Promise<RecoveryOutcome> {
  const settlement = await settleGrowthRead(
    bridge.growth.healthRecoveryActionRequest({ runId, action }),
  );
  return settlement.status === "served"
    ? { kind: "settled", action, receipt: settlement.value }
    : { kind: "refused", action, refusal: settlement };
}
