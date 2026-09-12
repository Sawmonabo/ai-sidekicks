// The presence plane's ledger row: the session's live activity, read.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the row it heads.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The id this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too.
 */
type PresenceOperationId = Extract<GrowthOperationId, "presenceActivityRead">;

/**
 * The presence row.
 *
 * IT NAMES NO WIRE METHOD, and that is a fact about the wire rather than an
 * omission. `activity.runs` is a Yjs Awareness FIELD — Awareness state carried beside
 * the presence heartbeat, minting no durable event and registered as no JSON-RPC
 * method. The daemon's presence handler surface is what will answer for it, and the
 * string it answers to is that surface's to choose; an `expectedWireMethod` invented
 * here would be a wire fact traceable to nothing — the disposition the identity
 * plane's rows take for the same reason.
 */
export const PRESENCE_GROWTH_OPERATIONS: Readonly<
  Record<PresenceOperationId, GrowthOperationEntry>
> = {
  presenceActivityRead: op("presenceActivityRead", "presence-activity-fields", "method"),
};
