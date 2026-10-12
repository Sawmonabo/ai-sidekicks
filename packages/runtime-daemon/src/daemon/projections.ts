// The session projections the daemon rebuilds from each session's log, in the order a rebuild
// clears and writes them.

import { APPROVALS_PROJECTION } from "../approvals/projection/rebuild.js";
import type { SessionProjection } from "../recovery/projection-rebuild.js";
import { SESSION_DIRECTORY_PROJECTION } from "../session/directory/projection.js";
import { RUNS_PROJECTION } from "../session/run/projection.js";

/** Every session projection the daemon keeps, as its projection rebuild takes them. */
export const SESSION_PROJECTIONS: readonly SessionProjection[] = [
  SESSION_DIRECTORY_PROJECTION,
  RUNS_PROJECTION,
  APPROVALS_PROJECTION,
];
