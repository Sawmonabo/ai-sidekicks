// The attention plane's ledger rows: a session's attention projection, and the
// per-participant preferences that shape what lands in it.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type AttentionOperationId = Extract<GrowthOperationId, `attention${string}`>;

/** The attention rows, in the order the single table carried them. */
export const ATTENTION_GROWTH_OPERATIONS: Readonly<
  Record<AttentionOperationId, GrowthOperationEntry>
> = {
  attentionProjectionRead: op(
    "attentionProjectionRead",
    "attention-plane",
    "method",
    "read a session's actionable and informational attention, run-scoped items and the session aggregate together, over the daemon JSON-RPC transport",
    "attention.projectionRead",
  ),
  attentionPreferenceRead: op(
    "attentionPreferenceRead",
    "attention-plane",
    "method",
    "read the participant's global notification preferences, over the control-plane transport",
    "attention.preferenceRead",
  ),
  attentionPreferenceUpdate: op(
    "attentionPreferenceUpdate",
    "attention-plane",
    "method",
    "set one global notification preference, over the control-plane transport",
    "attention.preferenceUpdate",
  ),
};
