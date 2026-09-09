// The MCP governance plane's ledger rows: the unified inventory read, and the two
// mutations the operator page sends.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries. A pattern would be exact here and the names are written
 * out anyway, on the neighbouring planes' rule: the registered namespace holds eleven
 * operations and this table holds three, so a `mcp${string}` pattern would read as a
 * claim about the namespace rather than about what the console calls.
 */
type McpOperationId = Extract<GrowthOperationId, "mcpList" | "mcpSetEnabled" | "mcpSetTrust">;

/** The governance rows, reads first, in the registered registry's own order. */
export const MCP_GROWTH_OPERATIONS: Readonly<Record<McpOperationId, GrowthOperationEntry>> = {
  mcpList: op("mcpList", "mcp-governance-plane", "method", "mcp.list"),
  mcpSetEnabled: op("mcpSetEnabled", "mcp-governance-plane", "method", "mcp.setEnabled"),
  mcpSetTrust: op("mcpSetTrust", "mcp-governance-plane", "method", "mcp.setTrust"),
};

/**
 * What each of this plane's operations is, in a sentence.
 *
 * A second declaration rather than a member of the row beside it — `index.ts` states
 * the rule, which is `growth-slate-consumers.ts`'s: the split is by CONSUMER, and no
 * running console reads a sentence. The `Record` is over this plane's own id set, so a
 * row with no sentence and a sentence under an unknown id are both compile errors.
 */
export const MCP_GROWTH_OPERATION_SUMMARIES: Readonly<Record<McpOperationId, string>> = {
  mcpList:
    "read the unified server inventory — one row per scope-qualified binding, each carrying the daemon's own aggregate status, its live legs, its redacted configuration read-back, and its tool overrides",
  mcpSetEnabled:
    "enable or disable one binding, answering with the row as it now stands, where the change took effect, and what happened on each live leg",
  mcpSetTrust:
    "grant or revoke trust for one binding, which binds to that binding's current base-config hash",
};
