// The agent-definition plane's ledger rows: the node-local registry's list,
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
export type AgentDefinitionOperationId = Extract<
  GrowthOperationId,
  `agentDefinition${string}` | "agentPeerInvocationSet"
>;

/** The agent-definition rows, in the order the single table carried them. */
export const AGENT_DEFINITION_GROWTH_OPERATIONS: Readonly<
  Record<AgentDefinitionOperationId, GrowthOperationEntry>
> = {
  // agent definition — the registry's own order, and now the fifth pair beside them: the
  // per-session peer-invocation opt-in, which is session state rather than a
  // definition and reached the ledger when the control that sets it landed.
  agentDefinitionList: op(
    "agentDefinitionList",
    "agent-definition-registry",
    "method",
    "agent.definitionList",
  ),
  agentDefinitionCreate: op(
    "agentDefinitionCreate",
    "agent-definition-registry",
    "method",
    "agent.definitionCreate",
  ),
  agentDefinitionUpdate: op(
    "agentDefinitionUpdate",
    "agent-definition-registry",
    "method",
    "agent.definitionUpdate",
  ),
  agentDefinitionDelete: op(
    "agentDefinitionDelete",
    "agent-definition-registry",
    "method",
    "agent.definitionDelete",
  ),
  agentPeerInvocationSet: op(
    "agentPeerInvocationSet",
    "agent-definition-registry",
    "method",
    "agent.peerInvocationSet",
  ),
};
