// The agent plane's ledger rows: the session roster read the composer's target chip
// renders.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the row it heads.

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
type AgentOperationId = Extract<GrowthOperationId, `agent${string}`>;

/** The agent rows, in the order the single table carried them. */
export const AGENT_GROWTH_OPERATIONS: Readonly<Record<AgentOperationId, GrowthOperationEntry>> = {
  // the agent roster — the composer's target chip reads the paying account and the
  // pending switch off it, and the deferred failure arm rides an event type this
  // console cannot fold, which is the `agent-provider-switch-failure` prerequisite.
  agentList: op(
    "agentList",
    "agent-roster-read",
    "method",
    "read a session's agents with the effective provider axis and any pending switch, the two facts the target chip renders and no entity body carries",
    "agent.list",
  ),
};
