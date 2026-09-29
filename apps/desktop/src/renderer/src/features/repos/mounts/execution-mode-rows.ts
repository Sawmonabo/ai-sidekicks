// One row of the execution-mode picker, and the one derivation that builds the set.
//
// A MODULE OF ITS OWN because two surfaces build these rows and two views draw them,
// so the shape is the seam between them rather than either one's private vocabulary —
// and a type declared in a parent component and imported by its child closes an import
// cycle.
//
// AND THE DERIVATION LIVES HERE BESIDE THE SHAPE, because two surfaces need it. The mode
// picker and the bind dialog each read one `repo.executionModeCapabilitiesRead` reply
// into rows, and two separate readings could drift on the case that matters most: a mode
// named in BOTH halves of the reply. If one kept the reason and the other blanked it, the
// same malformed reply would disclose its restriction on one surface and hide it on the
// other. One implementation serves both.

import { type ExecutionMode } from "@ai-sidekicks/contracts";
import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";

/** One row, after the reply has been read but before anything is rendered. */
export interface ExecutionModeRowReading {
  readonly mode: ExecutionMode;
  readonly available: boolean;
  /** The daemon's own words for why this mode is unavailable. Never composed here. */
  readonly restrictionReason: string | undefined;
}

/**
 * The rows, built from the reply and from nothing else.
 *
 * Available modes first, in the order the daemon listed them; then every restricted
 * mode, in the order its reasons arrived. The console imposes no ranking of its own on
 * either half, and an excluded mode with no entry in the map has no reason on file,
 * which the row says outright rather than filling in.
 *
 * A MODE NAMED IN BOTH HALVES IS RENDERED ONCE, AS AVAILABLE, AND KEEPS ITS REASON
 * VISIBLE. The reply is malformed in that case, and hiding half of it would be the
 * renderer deciding which half was true.
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
