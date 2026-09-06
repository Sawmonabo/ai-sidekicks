// The sidekick-definition plane: the node-local registry's list, create, update,
// and delete, and the per-session peer-invocation grant beside them.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// section and row comments below are the file's own, kept with the rows they
// explain.

import type {
  PeerInvocationReading,
  PeerInvocationSetRequest,
  SidekickDefinition,
  SidekickDefinitionDraft,
} from "../wire-shapes/index.js";

export interface SidekickGrowthSignatures {
  // sidekick — the registry's four definition pairs in its own order, and the
  // per-session grant beside them.
  sidekickDefinitionList: {
    // Node-local and unfiltered, so the request carries no members. Named empty
    // rather than omitted, matching the registered request half — every operation in
    // the namespace has both halves of its pair and no caller special-cases a
    // missing request type.
    request: Record<string, never>;
    value: readonly SidekickDefinition[];
  };
  sidekickDefinitionCreate: { request: SidekickDefinitionDraft; value: SidekickDefinition };
  // A partial patch over the same axes, plus the id it patches — `Partial` of the
  // draft rather than a second axis list, which would drift the first time an axis
  // landed on one and not the other. `sidekick-definition.ts` says why the draft and
  // the stored row stay two shapes while the two WRITES stay one.
  sidekickDefinitionUpdate: {
    request: { readonly definitionId: string } & Partial<SidekickDefinitionDraft>;
    // The full post-update row, so a client never reconstructs it by merging its own
    // patch — which would be a second projection of a fact the daemon just settled.
    value: SidekickDefinition;
  };
  sidekickDefinitionDelete: {
    request: { readonly definitionId: string };
    value: { readonly deleted: true };
  };
  // The grant reads back the post-append PROJECTED value rather than echoing the
  // request, so a caller renders what the daemon recorded. Its own reading type and
  // not a bare boolean: absence is a third state, never `false`.
  sidekickPeerInvocationSet: { request: PeerInvocationSetRequest; value: PeerInvocationReading };
}
