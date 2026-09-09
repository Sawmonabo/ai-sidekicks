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
