// The identity plane: which user this window IS, and which callback tools
// the session it is looking at has registered.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. Both
// rows answer a question about the CALLER's standing in a session rather than about
// its contents, which is why the file's own `identity` section carries them
// together. The section and row comments below are the file's own.

import type { GrowthCallbackTool, GrowthPresenceDetail } from "../growth-values/index.js";

export interface IdentityGrowthSignatures {
  // identity
  //
  // The value is the identifier and nothing else, which is the whole of what is
  // missing. A session's user roster already carries every member's role, and
  // the store partitions by user, so a `role` member here would be a second
  // source of truth for a fact another partition owns — and the two could disagree
  // with nothing able to say which was right (`store/entities/entities.ts`: a store never
  // caches a flag another store owns). What no registered read supplies is which
  // entry in that roster this window IS; given that, the role is a lookup.
  callerUserRead: {
    request: { readonly sessionId: string };
    value: { readonly userId: string };
  };
  // The SESSION's registry, not one run's: the registered set is curated per session
  // and rides spawn, so there is no per-run narrowing to ask for. A `runId` member
  // would be a request field with no caller, minted ahead of its reader.
  callbackToolRegistryRead: {
    request: { readonly sessionId: string };
    value: readonly GrowthCallbackTool[];
  };
  // The per-device fan-out, which IS per-user: the read is owner/operator-only
  // and the surface asks for exactly the row a person opened. The reply carries the
  // aggregate the summary already showed, so the detail and the summary can be told
  // apart rather than reconciled.
  userPresenceDetailRead: {
    request: { readonly sessionId: string; readonly userId: string };
    value: GrowthPresenceDetail;
  };
}
