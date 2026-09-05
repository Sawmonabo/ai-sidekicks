// The identity plane: which participant this window IS, and which callback tools
// the session it is looking at has registered.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. Both
// rows answer a question about the CALLER's standing in a session rather than about
// its contents, which is why the file's own `identity` section carries them
// together. The section and row comments below are the file's own.

import type { GrowthCallbackTool } from "../growth-values/index.js";

export interface IdentityGrowthSignatures {
  // identity
  //
  // The value is the identifier and nothing else, which is the whole of what is
  // missing. A session's participant roster already carries every member's role, and
  // the store partitions by participant, so a `role` member here would be a second
  // source of truth for a fact another partition owns — and the two could disagree
  // with nothing able to say which was right (`store/entities.ts`: a store never
  // caches a flag another store owns). What no registered read supplies is which
  // entry in that roster this window IS; given that, the role is a lookup.
  callerParticipantRead: {
    request: { readonly sessionId: string };
    value: { readonly participantId: string };
  };
  // The SESSION's registry, not one run's: the registered set is curated per session
  // and rides spawn, so there is no per-run narrowing to ask for. A `runId` member
  // would be a request field with no caller, minted ahead of its reader.
  callbackToolRegistryRead: {
    request: { readonly sessionId: string };
    value: readonly GrowthCallbackTool[];
  };
}
