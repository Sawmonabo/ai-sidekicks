// The presence plane's ledger rows: the session's live activity, read and published.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the rows it heads.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too.
 */
type PresenceOperationId = Extract<
  GrowthOperationId,
  "presenceActivityRead" | "presenceComposingSet" | "presenceComposingClear"
>;

/**
 * The presence rows.
 *
 * NONE NAMES A WIRE METHOD, and that is a fact about the wire rather than an
 * omission. `activity.typing` and `activity.runs` are Yjs Awareness FIELDS
 * (`Spec-002 §Default Behavior`) — Awareness state carried beside the presence
 * heartbeat, minting no durable event and registered as no JSON-RPC method anywhere
 * in the corpus. What Plan-002 T3.5 owes is a daemon presence handler surface for
 * them, and the string that surface will answer to is that task's to choose; an
 * `expectedWireMethod` invented here would be a wire fact traceable to nothing —
 * the disposition the identity plane's rows take for the same reason.
 */
export const PRESENCE_GROWTH_OPERATIONS: Readonly<
  Record<PresenceOperationId, GrowthOperationEntry>
> = {
  presenceActivityRead: op("presenceActivityRead", "presence-activity-fields", "method"),
  presenceComposingSet: op("presenceComposingSet", "presence-activity-fields", "method"),
  presenceComposingClear: op("presenceComposingClear", "presence-activity-fields", "method"),
};
