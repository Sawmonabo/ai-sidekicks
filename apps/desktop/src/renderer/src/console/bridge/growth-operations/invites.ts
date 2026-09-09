// The invite plane's ledger rows: the pending-invite namespace, and the host a
// shareable link is written on.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comments below are the single table's own, kept with the rows they head.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `invitesList` is deliberately NOT among them: the invites READ is the session
 * plane's row and has been since that plane was written, and moving it here to make
 * the word `invite` name one plane would put one wire under two owners for a
 * fortnight and lose it in whichever merge landed second.
 */
type InviteOperationId = Extract<
  GrowthOperationId,
  | "invitePendingSubscribe"
  | "inviteOutcomeSubscribe"
  | "inviteConfirmPending"
  | "inviteRetryPending"
  | "inviteDismissPending"
  | "controlPlaneHostRead"
>;

/** The invite rows, in the order a deep link meets them. */
export const INVITE_GROWTH_OPERATIONS: Readonly<Record<InviteOperationId, GrowthOperationEntry>> = {
  // the pending-invite namespace
  //
  // Every one of these five NAMES its wire method, unlike the presence plane beside
  // it: `Spec-023 §Preload Bridge Contract` writes the namespace out verbatim —
  // `subscribePending`, `subscribeOutcome`, `confirmPending`, `retryPending`,
  // `dismissPending` — so the string is quoted rather than chosen, and the day the
  // bridge grows the namespace the two cannot disagree about what it is called.
  invitePendingSubscribe: op(
    "invitePendingSubscribe",
    "pending-invite-namespace",
    "subscription",
    "invite.subscribePending",
  ),
  inviteOutcomeSubscribe: op(
    "inviteOutcomeSubscribe",
    "pending-invite-namespace",
    "subscription",
    "invite.subscribeOutcome",
  ),
  inviteConfirmPending: op(
    "inviteConfirmPending",
    "pending-invite-namespace",
    "method",
    "invite.confirmPending",
  ),
  inviteRetryPending: op(
    "inviteRetryPending",
    "pending-invite-namespace",
    "method",
    "invite.retryPending",
  ),
  inviteDismissPending: op(
    "inviteDismissPending",
    "pending-invite-namespace",
    "method",
    "invite.dismissPending",
  ),
  // the control-plane host
  //
  // No method string, because no read anywhere in the corpus carries this fact:
  // `Spec-002 §Invite Delivery` fixes the LINK's shape and leaves who tells a client
  // its own control-plane host unstated. An invented name here would be a wire fact
  // traceable to nothing — the identity plane's disposition, for the same reason.
  controlPlaneHostRead: op("controlPlaneHostRead", "control-plane-host", "method"),
};
