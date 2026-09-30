// Whether one approval can still be answered, and the answer it sends. One reading and
// one request, two consumers.
//
// The card and the palette row offer the same act, and every operator
// action is in the palette — so a row the pane has withdrawn is a row that answers a
// request nobody is waiting on. Both used to derive that independently and the two
// derivations disagreed: the card took its two buttons off on a SETTLED refusal
// (`approval.already_resolved` — somebody else answered) and the row builder never saw
// a per-record refusal at all, so the palette kept offering a decision the card had
// already withdrawn.
//
// SO IT IS ONE FUNCTION RATHER THAN TWO THAT AGREE, on the precedent
// `run-controls/run-control-gating.ts` sets for the six run controls: the row
// builder and the on-screen control call the same `offeredRunControls`, so there is
// nothing to drift. A second expression of one offer rule is a drift that reports
// nothing when it happens — both halves stay green, and the disagreement is visible
// only to the person who presses the row that should not have been there.
//
// IT IS AN OFFER READING AND NOT AN ELIGIBILITY PROJECTION. Whether the daemon will
// accept the decision is the daemon's to say and reaches the card as a typed
// refusal; what this answers is narrower — whether this console has already been
// told, in an answer it is holding, that the act is over.

import type {
  ApprovalDecision,
  ApprovalProjectionRow,
  ApprovalResolveRequest,
  RememberedScope,
} from "@ai-sidekicks/contracts";

import { refusalRemedyFor } from "@renderer/lib/refusal-remedies.js";
import { type Refusal } from "@renderer/lib/refusal.js";

/**
 * Whether this record's two answers are still offered.
 *
 * `false` once the record has left `pending`, and once a refusal the shared remedy
 * table marks `settled` has landed against it: that refusal means the request was
 * answered elsewhere, so every further press earns the same refusal and the next
 * projection read drops the record entirely.
 */
export function isApprovalAnswerable(
  record: ApprovalProjectionRow,
  refusal: Refusal | undefined,
): boolean {
  if (record.state !== "pending") {
    return false;
  }
  return refusalRemedyFor(refusal?.code ?? "")?.settled !== true;
}

/**
 * The answer one press sends.
 *
 * It names no `effectiveScope`, so the daemon applies the scope the ask was raised with
 * and the console holds no control that could widen it. Each press mints its own
 * `clientResolutionId`, which the daemon echoes on the resolution event, so the
 * device that answered draws nothing and every other device showing the card learns
 * it was answered elsewhere. `rememberedScope` is present only where the person chose
 * to remember the answer.
 */
export function approvalAnswer(
  record: ApprovalProjectionRow,
  decision: ApprovalDecision,
  rememberedScope: RememberedScope | undefined,
): ApprovalResolveRequest {
  return {
    approvalRequestId: record.id,
    decision,
    clientResolutionId: crypto.randomUUID(),
    ...(rememberedScope === undefined ? {} : { rememberedScope }),
  };
}
