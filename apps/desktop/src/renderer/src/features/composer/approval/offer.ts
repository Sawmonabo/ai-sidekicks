// Whether one approval can still be answered, and the answer a press sends. The card and the
// palette row call these same functions so their offers cannot disagree. This reads only what
// the console already holds; whether the daemon accepts the decision reaches the card as a
// typed refusal.

import type {
  ApprovalDecision,
  ApprovalProjectionRow,
  ApprovalResolveRequest,
  RememberedScope,
} from "@ai-sidekicks/contracts/approval";

import { refusalRemedyFor } from "#renderer/lib/refusal/remedies.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";

/**
 * Whether the record's approve and reject answers are still offered: false once it leaves
 * `pending`, or once a `settled` refusal (answered elsewhere) has landed against it.
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
 * The answer one press sends. It names no `effectiveScope`, so the daemon applies the scope the
 * ask was raised with. Each press mints its own `clientResolutionId`, which the daemon echoes on
 * the resolution event. `rememberedScope` is present only when the person chose to remember.
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
