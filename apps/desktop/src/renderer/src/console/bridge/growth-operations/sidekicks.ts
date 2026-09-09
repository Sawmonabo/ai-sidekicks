// The sidekick-definition plane's ledger rows: the node-local registry's list,
// create, update, and delete, and the per-session peer-invocation grant beside
// them.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the rows it heads.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type SidekickOperationId = Extract<GrowthOperationId, `sidekick${string}`>;

/** The sidekick rows, in the order the single table carried them. */
export const SIDEKICK_GROWTH_OPERATIONS: Readonly<
  Record<SidekickOperationId, GrowthOperationEntry>
> = {
  // sidekick — the registry's own order, and now the fifth pair beside them: the
  // per-session peer-invocation opt-in, which is session state rather than a
  // definition and reached the ledger when the control that sets it landed.
  sidekickDefinitionList: op(
    "sidekickDefinitionList",
    "sidekick-definition-registry",
    "method",
    "sidekick.definitionList",
  ),
  sidekickDefinitionCreate: op(
    "sidekickDefinitionCreate",
    "sidekick-definition-registry",
    "method",
    "sidekick.definitionCreate",
  ),
  sidekickDefinitionUpdate: op(
    "sidekickDefinitionUpdate",
    "sidekick-definition-registry",
    "method",
    "sidekick.definitionUpdate",
  ),
  sidekickDefinitionDelete: op(
    "sidekickDefinitionDelete",
    "sidekick-definition-registry",
    "method",
    "sidekick.definitionDelete",
  ),
  sidekickPeerInvocationSet: op(
    "sidekickPeerInvocationSet",
    "sidekick-definition-registry",
    "method",
    "sidekick.peerInvocationSet",
  ),
};

/**
 * What each of this plane's operations is, in a sentence.
 *
 * A second declaration rather than a member of the row beside it — `index.ts` states
 * the rule, which is `growth-slate-consumers.ts`'s: the split is by CONSUMER, and no
 * running console reads a sentence. The `Record` is over this plane's own id set, so a
 * row with no sentence and a sentence under an unknown id are both compile errors.
 */
export const SIDEKICK_GROWTH_OPERATION_SUMMARIES: Readonly<Record<SidekickOperationId, string>> = {
  sidekickDefinitionList:
    "list this node's saved sidekick definitions, unfiltered — the registry returns full records, so there is no separate read verb to pair with it",
  sidekickDefinitionCreate:
    "save a new definition, every axis but the name optional and an omitted axis stored as the inherit state rather than as today's default materialised",
  sidekickDefinitionUpdate:
    "patch a definition, an absent key leaving the stored value alone and an explicit null clearing it back to the inherit state",
  sidekickDefinitionDelete:
    "delete a definition, which never touches an agent attached from it because attach copies rather than references",
  sidekickPeerInvocationSet:
    "set the session-scoped peer-invocation grant, answering with the post-append projected value so a caller renders what the daemon recorded rather than what it asked for",
};
