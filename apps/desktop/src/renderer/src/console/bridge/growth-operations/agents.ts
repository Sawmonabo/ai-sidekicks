// The agent plane's ledger rows: the four verbs that move a session's roster, and
// the child-run linkage read that makes refused delegated work visible.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comments below are the single table's own, kept with the rows they head.
//
// The linkage read shares this module rather than the ledger plane's because it
// shares this plane's READER: the agent console renders one parent run's children
// beside the roster entry that spawned them, and a child-run link is a fact about an
// agent's work rather than about a session's spend.

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
type AgentOperationId = Extract<
  GrowthOperationId,
  `agent${string}` | "orchestrationChildRunLinkRead"
>;

/** The agent rows, in the order the single table carried them. */
export const AGENT_GROWTH_OPERATIONS: Readonly<Record<AgentOperationId, GrowthOperationEntry>> = {
  // agent plane — the four verbs, in the order a surface meets them.
  agentList: op("agentList", "agent-snapshot-axes", "method", "agent.list"),
  agentAttach: op("agentAttach", "agent-snapshot-axes", "method", "agent.attach"),
  agentConfigUpdate: op("agentConfigUpdate", "agent-snapshot-axes", "method", "agent.configUpdate"),
  agentDetach: op("agentDetach", "agent-snapshot-axes", "method", "agent.detach"),
  // orchestration — the one read that makes refused work visible at all.
  orchestrationChildRunLinkRead: op(
    "orchestrationChildRunLinkRead",
    "child-run-linkage",
    "method",
    "orchestration.childRunLinkRead",
  ),
};
