// The result shape and the wire bound that both drivers' MCP server-status normalizers share.
// Each driver maps its own status vocabulary; the bound and the rejection shape are
// provider-neutral.

import type { McpServerStatus } from "@ai-sidekicks/contracts";
import { McpServerStatusEmissionSchema, type McpServerStatusEmission } from "../provider-driver.js";

/**
 * A raw row, line or notification a normalizer could not turn into a bounded emission.
 * Rejections are returned, never dropped, so a malformed row shows up as a visible gap.
 */
export interface McpServerStatusIngestRejection {
  readonly reason: string;
}

/** The outcome of normalizing one raw ingress payload into bounded emissions. */
export interface McpServerStatusIngestResult {
  readonly emissions: readonly McpServerStatusEmission[];
  readonly rejections: readonly McpServerStatusIngestRejection[];
}

/**
 * Bounds one (serverName, status) pair through the contract schema. `serverName` is untrusted
 * provider output; a pair outside the bound (length 1..128, non-whitespace, no NUL) comes back
 * as a rejection instead of reaching the daemon-injected producer.
 */
export function boundMcpServerStatusEmission(
  serverName: unknown,
  status: McpServerStatus,
): { emission?: McpServerStatusEmission; rejection?: McpServerStatusIngestRejection } {
  const parsed = McpServerStatusEmissionSchema.safeParse({ serverName, status });
  if (parsed.success) {
    return { emission: parsed.data };
  }
  return {
    rejection: {
      reason: `MCP server-status emission rejected at the wire bound: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    },
  };
}
