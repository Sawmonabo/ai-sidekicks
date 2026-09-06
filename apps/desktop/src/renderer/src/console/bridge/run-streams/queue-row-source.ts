// Where the queue ROW comes from, for a stream that projects one.
//
// `run.subscribeQueue` streams `QueueItemSummary`, and a summary is a projection of
// the `queue_items` ROW rather than of the event that announced a change to it. The
// two do not carry the same members and were never meant to: `Spec-006 §Queue
// Events` fixes the canonical payload at `{sessionId, queueItemId, channelId?,
// state}`, while `QueueItemSummarySchema` (`packages/contracts/src/runControl.ts`)
// requires `priority`, `createdAt`, and `updatedAt` as well. The daemon closes that
// gap by reading the row; it has one.
//
// THE DEFECT THIS REPLACES. The projection demanded `priority` on every queue beat
// and `createdAt` on every beat but the creation row, so a beat carrying exactly
// what `Spec-006` registers was REFUSED as unprojectable — and the only way to make
// the fixture deliver was to script payload members onto a beat that no daemon
// emits, which is the fixture teaching a surface about a wire that does not exist.
// Both halves were wrong in the same direction: the members were being sourced from
// the one place that cannot have them.
//
// WHERE THEY COME FROM INSTEAD. `run.queueList` is the registered read whose reply
// is `QueueItemListResponse` — `{items: QueueItemSummary[]}`, the rows themselves
// (`docs/architecture/contracts/api-payload-contracts.md`, the Plan-004 wire
// registry). The fixture's stand-in for a daemon read is a scripted reply, so a
// scenario that plays queue beats scripts that read too, and the projection composes
// the summary the way the daemon does: the row supplies `priority` and `createdAt`,
// the beat supplies the state its kind announces and the instant it occurred. A
// scenario that scripts no row read gets a refusal naming the read — the honest
// answer for a stream whose payload the fixture has no source for — rather than a
// made-up priority.
//
// WHY THIS IS ITS OWN MODULE. Two sides of one seam: `fixture-bridge.ts` names the
// read when it resolves the scenario's reply, and `run-stream-projection.ts` reads
// the row out of it. A second spelling of `"run.queueList"` on the other side of
// that seam would be a fixture looking up a reply nobody scripts.

/**
 * The registered read whose reply carries the queue rows.
 *
 * Spelled once, here, because the scenario author writes it into a `replies` entry
 * and the fixture looks the same string up — the shape of drift the stream table
 * beside this module was written to end.
 */
export const RUN_QUEUE_ROW_READ = "run.queueList";

/**
 * The row for one queue item, as the scenario's scripted read supplies it, or
 * `undefined` when that read supplies none.
 *
 * Returns the row RAW rather than a typed projection of it: deciding which members
 * a `QueueItemSummary` needs and whether the values are well-formed belongs to the
 * projection and to the registered schema it parses through, and this module would
 * be a second reading of both. What it decides is the one question only it can
 * answer — which row of the scripted read this beat is about.
 *
 * `undefined` covers every way the read can fail to name the row, and deliberately
 * does not distinguish them: an unscripted read, a reply of another shape, and a
 * reply whose rows do not include this one all leave the projection with no source
 * for the row-only members, which is one refusal and not three.
 */
export function scriptedQueueRowFor(
  scriptedReadResult: unknown,
  queueItemId: string,
): Readonly<Record<string, unknown>> | undefined {
  return scriptedQueueRows(scriptedReadResult).find((row) => row["id"] === queueItemId);
}

/** The `items` array of a `QueueItemListResponse`-shaped reply, or none. */
function scriptedQueueRows(
  scriptedReadResult: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  if (!isWireObject(scriptedReadResult)) {
    return [];
  }
  const items = scriptedReadResult["items"];
  return Array.isArray(items) ? items.filter(isWireObject) : [];
}

/** A reply member as an object with readable keys — not an array, not `null`. */
function isWireObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
