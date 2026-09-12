// The presence plane: what the session's live activity state reads as.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. One row
// on one slate row, because the `activity.runs` map is one publication surface and
// the console only ever reads it.
//
// THE SET CARRIES NO WRITE. The owning daemon's own Awareness client writes every
// agent indicator, so that a renderer crash can neither strand a live run's entry nor
// falsely clear it.

import type { GrowthActivitySnapshot } from "../growth-values/index.js";

export interface PresenceGrowthSignatures {
  // presence — the Awareness activity field.
  //
  // A READ AND NOT A SUBSCRIPTION, and the reason is the runtime-node roster's.
  // Awareness state
  // is a map each publisher owns, the session's presence stream already delivers a
  // change signal, and `seats/read/push-driven-read.ts` is the console's one answer to
  // "subscribe first, answer the signal with a fresh read". A second subscription
  // here would be a second delivery path for one session's presence traffic, and the
  // two could disagree about which run is working with nothing able to say which was
  // right.
  presenceActivityRead: {
    request: { readonly sessionId: string };
    value: GrowthActivitySnapshot;
  };
}
