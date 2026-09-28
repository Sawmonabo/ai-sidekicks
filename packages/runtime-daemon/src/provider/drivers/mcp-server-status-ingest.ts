// The result shape and the wire bound both drivers' MCP server-status census
// normalizers share. Each driver maps its own status vocabulary; the bound and
// the rejection shape are provider-neutral. Pure normalization: nothing here
// depends on the diagnostic module.

import { McpServerStatusEmissionSchema } from "@ai-sidekicks/contracts";
import type { McpServerStatus, McpServerStatusEmission } from "@ai-sidekicks/contracts";

/**
 * A raw row, line or notification a census normalizer could not turn into a
 * bounded emission. Rejections are RETURNED, never dropped — the wiring seam
 * routes them to the driver diagnostic surface so a malformed row is a visible
 * census gap.
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
 * Bounds one (serverName, status) pair through the contract schema.
 * `serverName` is untrusted provider output and is `wireFreeFormString`-bounded
 * (length 1..128, non-whitespace, no NUL) here, before the emission can reach the
 * daemon-injected producer; a pair outside the bound comes back as a rejection.
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
