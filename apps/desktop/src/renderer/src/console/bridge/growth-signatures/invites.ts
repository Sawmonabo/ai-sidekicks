// The invite plane: the pending confirmation a deep link produces, and the host an
// invitation's link is composed from.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. Two slate
// rows meet here because the second exists only for the first's sake in reverse: one
// is how an invitation ARRIVES at this window, the other is what an invitation this
// window MINTS has to be written on to be sendable at all.
//
// EVERY REQUEST ON THE PENDING SIDE CARRIES A REFERENCE AND NEVER A TOKEN.
// `Plan-023 §Invariants` I-023-5 keeps the raw token in the main process and I-023-10
// makes the reference opaque, single-use and TTL-bounded. So the confirm, retry, and
// dismiss requests below are each exactly one opaque string — there is no second
// member a caller could smuggle a credential in, and a reference already consumed
// resolves to nothing rather than being re-resolved.
//
// THE TWO SUBSCRIPTIONS ARE SEPARATE BECAUSE THE FACTS ARE. A pending invitation is a
// question that has arrived; an outcome is what happened to an answer already given.
// A single feed carrying both would make a surface discriminate two lifecycles on one
// stream, and a window that joined after the pending frame would read the outcome of
// a confirmation it never showed.
//
// `invite.preview` ITSELF IS NOT HERE. It is a registered control-plane mutation the
// MAIN process issues (`Plan-023 §Invariants` I-023-9), and its result is what mints
// the reference the pending feed delivers — so the renderer never calls it, and an
// operation for it would be a bridge method whose whole job the invariant forbids.

import type { GrowthStream } from "../growth-port/growth-outcome.js";
import type { GrowthInviteOutcome, GrowthPendingInvite } from "../growth-values/index.js";

export interface InviteGrowthSignatures {
  // the pending-invite namespace
  invitePendingSubscribe: {
    request: Record<string, never>;
    value: GrowthStream<GrowthPendingInvite>;
  };
  inviteOutcomeSubscribe: {
    request: Record<string, never>;
    value: GrowthStream<GrowthInviteOutcome>;
  };
  // The three acts, each on one reference. None answers with the outcome: acceptance
  // runs in main and can take an authentication detour, so what a caller waits for is
  // the outcome feed and never this reply. A settled value here would invite a
  // surface to render "joined" for a call that had only been accepted for dispatch.
  inviteConfirmPending: { request: { readonly reference: string }; value: undefined };
  inviteRetryPending: { request: { readonly reference: string }; value: undefined };
  inviteDismissPending: { request: { readonly reference: string }; value: undefined };
  // the control-plane host
  //
  // The bare host and nothing else. `Spec-002 §Invite Delivery` fixes the link's own
  // shape — `https://<control-plane-host>/invite/<token>` — so a reply carrying a
  // whole URL template would move the composition to the wire and let the two spell
  // the path differently; a reply carrying a scheme would let a node hand this
  // renderer a link it must not offer to send.
  controlPlaneHostRead: {
    request: Record<string, never>;
    value: { readonly host: string };
  };
}
