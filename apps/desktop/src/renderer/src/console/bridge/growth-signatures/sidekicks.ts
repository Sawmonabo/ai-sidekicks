// The sidekick-definition plane: the node-local registry's list, create, update,
// and delete.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// section and row comments below are the file's own, kept with the rows they
// explain.

import type { SidekickDefinition, SidekickDefinitionDraft } from "../wire-shapes/index.js";

export interface SidekickGrowthSignatures {
  // sidekick — four of the five registered pairs, in the registry's own order. The
  // fifth is named in the slate row's own wire text: the per-session peer-invocation
  // opt-in is session state rather than a definition, and no surface on this
  // substrate sets it.
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
}
