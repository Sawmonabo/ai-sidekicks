// The presence plane: what the session's live activity state reads as, and how a
// composer says it is composing.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. Three
// rows on one slate row, because they are one publication surface read from both
// ends — the console receives everyone's activity through the read and publishes its
// own participant's through the two writes.
//
// THE WRITE PAIR NAMES NO PARTICIPANT, AND THAT IS THE SECURITY PROPERTY. The
// publisher is the authenticated caller the daemon already resolved, so a request
// member for it would be a claim a renderer could forge — the class rule
// `api-payload-contracts.md §Authenticated Principal And Authorization Model` states.
// What the caller supplies is only WHERE it is composing.
//
// AND THE SET CARRIES NO AGENT-SIDE WRITE. `Spec-002 §Default Behavior` requires the
// owning daemon's own Awareness client to write every agent indicator, so that a
// renderer crash can neither strand a live run's entry nor falsely clear it. An
// operation here would be the console asking for a capability the spec forbids it.

import type { GrowthActivitySnapshot } from "../growth-values/index.js";

export interface PresenceGrowthSignatures {
  // presence — the two Awareness activity fields.
  //
  // A READ AND NOT A SUBSCRIPTION, and the reason is the roster's. Awareness state
  // is a map each publisher owns, the session's presence stream already delivers a
  // change signal, and `seats/push-driven-read.ts` is the console's one answer to
  // "subscribe first, answer the signal with a fresh read". A second subscription
  // here would be a second delivery path for one session's presence traffic, and the
  // two could disagree about who is composing with nothing able to say which was
  // right.
  presenceActivityRead: {
    request: { readonly sessionId: string };
    value: GrowthActivitySnapshot;
  };
  // The composer's own emit. `channelId` is the channel the message is being written
  // in; the daemon applies `Spec-002 §Default Behavior`'s membership-restricted
  // suppression before anything leaves the machine, and the composer does not route
  // around it (CP-023-4).
  presenceComposingSet: {
    request: { readonly sessionId: string; readonly channelId: string };
    value: undefined;
  };
  // The stop signal, sent when the person stops typing rather than left to a
  // receiver timeout. The receiver's own stale bound is the backstop for a client
  // that vanished mid-sentence, never the ordinary way an indicator ends.
  presenceComposingClear: {
    request: { readonly sessionId: string };
    value: undefined;
  };
}
