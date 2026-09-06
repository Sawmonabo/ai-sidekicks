// Whether one approval can still be answered. One reading, two consumers.
//
// The card and the palette row are the same act on two surfaces, and
// `Spec-023 §Rules every console surface obeys` puts every operator action in the
// palette — so a row the pane has withdrawn is a row that answers a request nobody
// is waiting on. Both used to derive that independently and the two derivations
// disagreed: the card took its two buttons off on a SETTLED refusal
// (`approval.already_resolved` — somebody else answered) and the row builder never
// saw a per-record refusal at all, so the palette kept offering a decision the card
// had already withdrawn.
//
// SO IT IS ONE FUNCTION RATHER THAN TWO THAT AGREE, on the precedent
// `runs/pane/controls/run-control-gating.ts` sets for the six run controls: the row
// builder and the on-screen control call the same `offeredRunControls`, so there is
// nothing to drift. A second expression of one offer rule is a drift that reports
// nothing when it happens — both halves stay green, and the disagreement is visible
// only to the person who presses the row that should not have been there.
//
// IT IS AN OFFER READING AND NOT AN ELIGIBILITY PROJECTION. Whether the daemon will
// accept the decision is the daemon's to say and reaches the surface as a typed
// refusal; what this answers is narrower — whether this console has already been
// told, in an answer it is holding, that the act is over.

import { refusalRemedyFor, type ConsoleRefusal } from "../../core/index.js";
import { asApprovalState, type ApprovalRecord } from "../../bridge/index.js";

/**
 * Whether this record's two answers are still offered.
 *
 * `false` once the record has left `pending`, and once a refusal the shared remedy
 * table marks `settled` has landed against it: that refusal means the request was
 * answered elsewhere, so every further press earns the same refusal and the next
 * projection read drops the record entirely.
 */
export function isApprovalAnswerable(
  record: ApprovalRecord,
  refusal: ConsoleRefusal | undefined,
): boolean {
  if (asApprovalState(record.state) !== "pending") {
    return false;
  }
  return refusalRemedyFor(refusal?.code ?? "")?.settled !== true;
}
