// Which tone each server status wears, declared once for the row's aggregate chip and each
// leg's chip. A total `Record` makes a new status a compile error, not a chip that renders
// neutral.

import type { ChipTone } from "#renderer/components/Chip/Chip.js";
import type { McpServerStatus } from "@ai-sidekicks/contracts/mcp/server";

/**
 * The mapping.
 *
 * `unknown` is `attention`, not `failure`: lost observability is not a fault. `starting` is
 * neutral because a transition is not news.
 */
const TONE_FOR_SERVER_STATUS: Readonly<Record<McpServerStatus, ChipTone>> = {
  failed: "failure",
  "needs-auth": "attention",
  unknown: "attention",
  starting: "neutral",
  connected: "accent",
};

/** The tone one status wears. */
export function toneForServerStatus(status: McpServerStatus): ChipTone {
  return TONE_FOR_SERVER_STATUS[status];
}
