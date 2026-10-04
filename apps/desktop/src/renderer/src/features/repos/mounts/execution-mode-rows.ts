// One row of the execution-mode picker, and the derivation that builds the set. The mode
// picker and the bind dialog both read a capabilities reply through it, so a mode named in
// both halves of a malformed reply cannot disclose its restriction in one and hide it in the
// other.

import type { ExecutionMode } from "@ai-sidekicks/contracts/repo";
import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts/workspace";

/** One row, after the reply has been read but before anything is rendered. */
export interface ExecutionModeRowReading {
  readonly mode: ExecutionMode;
  readonly available: boolean;
  /** The daemon's own words for why this mode is unavailable. Never composed here. */
  readonly restrictionReason: string | undefined;
}

/**
 * The rows, built from the reply alone: available modes first in the daemon's order, then each
 * restricted mode. A mode with no entry in `restrictions` has no reason on file and gets none
 * composed. A mode named in both halves is rendered once, as available, with its reason kept
 * visible rather than picking which half is true.
 */
export function executionModeRows(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
): readonly ExecutionModeRowReading[] {
  const restrictions = capabilities.restrictions ?? {};
  const rows: ExecutionModeRowReading[] = capabilities.availableModes.map((mode) => ({
    mode,
    available: true,
    restrictionReason: restrictions[mode],
  }));
  for (const [restrictedMode, reason] of Object.entries(restrictions)) {
    const mode = restrictedMode as ExecutionMode;
    if (rows.some((row) => row.mode === mode)) {
      continue;
    }
    rows.push({ mode, available: false, restrictionReason: reason });
  }
  return rows;
}
