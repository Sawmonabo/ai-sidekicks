// Which tone each server status wears, declared once for every surface that draws one.
//
// A `.ts` module rather than a table inside whichever component happened to need it
// first: the row's aggregate chip and each leg's own chip both key on this, and two
// tables would be two answers to one question the moment a status changed colour.
//
// A TOTAL `Record` RATHER THAN A SWITCH. A sixth status is then a compile error here
// rather than a chip that silently renders neutral, which is the difference between a
// vocabulary the surface is held to and one it happens to cover today.

import type { ChipTone } from "../../../../primitives/index.js";
import type { GrowthMcpServerStatus } from "../../../../bridge/index.js";

/**
 * The mapping.
 *
 * `unknown` is `attention` and deliberately not `failure`: lost observability is not
 * a fault, and colouring it as one would tell an operator that a binding which may be
 * perfectly healthy had broken. `starting` is neutral for the same reason in the
 * other direction — a transition is not news.
 */
const TONE_FOR_SERVER_STATUS: Readonly<Record<GrowthMcpServerStatus, ChipTone>> = {
  failed: "failure",
  "needs-auth": "attention",
  unknown: "attention",
  starting: "neutral",
  connected: "accent",
};

/** The tone one status wears. */
export function toneForServerStatus(status: GrowthMcpServerStatus): ChipTone {
  return TONE_FOR_SERVER_STATUS[status];
}
