// The MCP GOVERNANCE plane: the inventory read and the two mutations that move a row
// in it.
//
// WHY THIS PLANE HAS A MODULE. `workflows/workflow-reads.ts` and
// `diagnostics-reads.ts` state the shape — a plane whose answers need
// reasoning of their own leaves the port and takes its served ids with it, so the ids
// and the handlers stay one set with one home. This plane earns it twice over: the three
// answers are composed from ONE `FixtureMcpInventoryLedger`, and a ledger minted per
// handler would be a fixture where a mutation moves nothing the next read says. Holding
// them in the port also took that file past the package's split threshold.
//
// THE LEDGER IS MINTED HERE AND CLOSED OVER, which is what makes it one per port. It is
// deliberately not a parameter: a caller that could supply one could supply the same one
// to two ports, and a control pressed in one window would move another window's grid —
// a state no daemon can produce, since the two are reading different nodes.
//
// WHY THE INVENTORY READ IS SERVED AND ITS TWO MUTATIONS ARE SCRIPT-ONLY
//
// The operator page is an inventory and the controls on its rows, and none of it was
// reachable: no `mcp.*` wire is bound anywhere, so the whole page could only ever be
// drawn against one refusal. The read answers the EMPTY inventory for a scenario that
// scripts nothing, on the invite ledger's rule — a node governing no MCP servers is an
// ordinary node and the page draws that state with its add action, while "the inventory
// could not be read" is what a release build renders and is a different sentence.
//
// The two mutations are script-only for the reason that decides every write in this
// fixture, and one more that is this plane's own: each answers with the row as it now
// stands plus the per-leg outcomes of applying the change to live sessions, and a
// synthesized reply would report that the daemon reconciled sessions no author ever
// declared — the partial-outcome arm this page exists to render honestly.
//
// WHAT IS NOT HERE. The ledger's own substitution rule — which row replaces which, and
// why a mutation naming a binding the scripted inventory does not carry adds nothing —
// is `mcp-inventory.ts`', whose header carries the whole of it. What is HERE is
// only how each of the three served operations composes its answer out of that ledger.

import { FixtureMcpInventoryLedger } from "./mcp-inventory.js";
import { answerFromScriptedReply, answerScriptOnly } from "../growth/scripted-answer.js";
import { mapGrowthServed, type GrowthPort } from "../../growth-port/index.js";
import type { ScenarioEngine } from "../../scenario/runtime/engine.js";

/**
 * The three governance operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` in
 * `call-plane/served-operations.ts`, on
 * `FIXTURE_SERVED_WORKFLOW_OPERATION_IDS`' rule: the ids and the implementations below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until a control landed in only one of them.
 */
export const FIXTURE_SERVED_MCP_OPERATION_IDS = [
  "mcpList",
  "mcpSetEnabled",
  "mcpSetTrust",
] as const;

/** One governance operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedMcpOperationId = (typeof FIXTURE_SERVED_MCP_OPERATION_IDS)[number];

/**
 * The fixture's three governance answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureWorkflowReads`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 */
export function fixtureMcpGovernance(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedMcpOperationId> {
  // One ledger per port, so a mutation answered here is what the next read serves and
  // a disable pressed in this window cannot move another window's grid.
  const mcpInventory = new FixtureMcpInventoryLedger();
  return {
    // The read serves the scripted inventory with the ledger's rows substituted in, so
    // the grid does not put a disabled binding back on beside the mutation's own
    // applied outcome.
    mcpList: async (request) =>
      mapGrowthServed(
        await answerFromScriptedReply(engine, "mcp.list", "mcpList", request, () => ({
          status: "served",
          value: { servers: [] },
        })),
        (scripted) => mcpInventory.inventoryOver(scripted),
      ),
    mcpSetEnabled: async (request) =>
      mapGrowthServed(
        await answerScriptOnly(engine, "mcp.setEnabled", "mcpSetEnabled", request),
        (result) => mcpInventory.recordMutation(result),
      ),
    mcpSetTrust: async (request) =>
      mapGrowthServed(
        await answerScriptOnly(engine, "mcp.setTrust", "mcpSetTrust", request),
        (result) => mcpInventory.recordMutation(result),
      ),
  };
}
