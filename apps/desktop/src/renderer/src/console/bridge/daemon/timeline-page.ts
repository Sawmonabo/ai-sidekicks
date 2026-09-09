// One backward `timeline.read` window, read as the console's own event log.
//
// THE SECOND DECODE BOUNDARY, ON THE FIRST ONE'S TERMS. `session-event-payload.ts`
// narrows a delivered `EventEnvelope` into `ConsoleSessionEvent`, because
// `store/entities/entities.ts` puts exactly one module between the wire and everything above
// it. This module is that boundary for the other frame the daemon answers a session's
// log with — a `timeline.read` page — and it exists for the same reason: the store's
// log is `ConsoleSessionEvent` and a family above the bridge may not read a wire
// shape.
//
// WHY A PAGE IS DECODED BACKWARDS INTO THE LOG RATHER THAN RENDERED AS ROWS.
// `TimelineRow` is the daemon's own read projection: it carries the canonical event's
// members verbatim — `id`, `sessionId`, `sequence`, `type`, `timestamp`, `actor`,
// `payload` — and adds three the daemon DERIVES, `summary` and, on the run arms, the
// `position` / `epoch` ordinals. This console projects those three itself, over the
// whole window it holds, so a page decoded into the log is re-projected in the
// context of the rows around it; a page spliced in as rows would carry ordinals
// derived against a window this console never had, beside rows whose ordinals were
// derived against the one it does. One projection, one origin.
//
// SO THE DECODE IS TOTAL AND LOSES NOTHING THE LOG HOLDS. Every member
// `ConsoleSessionEvent` carries is required on `TimelineRowBase` except `actor`,
// which is optional in both, so there is no arm here for a row that cannot be read
// and no count of rows dropped: a page that parsed against the registered schema
// decodes completely. What is dropped is the daemon's derived triple, which this
// console re-derives, and `category` — which the forward boundary also checks and
// does not carry, because no reader of `ConsoleSessionEvent` reads one.
//
// WHAT THE REPLY SAYS ABOUT WHETHER MORE REMAIN IS THE REPLY'S, NEVER THIS MODULE'S.
// `hasMore` is required on both arms and the continuing arm's `nextCursor` is
// required with it, so "are there earlier rows" and "where does the next page start"
// are both answers the producer gave rather than facts a client inferred from a page
// being full. A page that came back short of the caller's `limit` says nothing here.

import type { TimelineReadResponse, TimelineRow } from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "../../store/index.js";

/** One backward window, in the shape the store's log speaks. */
export interface EarlierTimelinePage {
  /**
   * The window's rows as console events, in the order the producer sent them.
   *
   * Re-ordering is deliberately not done here: the response schema already refines
   * `entries` to run oldest-to-newest, so a second sort would be a second ordering of
   * one log — and the store's own merge orders what it admits anyway.
   */
  readonly events: readonly ConsoleSessionEvent[];
  /**
   * Whether rows remain before this window. The reply's `hasMore`, verbatim.
   *
   * NOT DERIVED FROM `nextCursor`'s PRESENCE. The terminal arm is permitted to carry
   * a cursor — it is where the window ended, which a caller resuming a subscription
   * needs — so reading the cursor as the discriminant would report more rows behind
   * every final page.
   */
  readonly hasEarlierRows: boolean;
  /**
   * Where this window ended: the position the NEXT backward page is asked before.
   *
   * Present on every continuing page by contract, and permitted on a terminal one.
   * Carried opaque and relayed verbatim or not at all, which is the whole of what a
   * console may do with a cursor (`store/session/timeline-resume.ts`).
   */
  readonly nextBeforeCursor: string | undefined;
}

/**
 * Read one backward `timeline.read` window into the console's event log.
 *
 * Takes the PARSED response rather than an `unknown`: the call door
 * (`daemon-reply.ts`) has already held the reply to the registered schema by the time
 * a caller has one of these, so a second parse here would be a second reading of one
 * seam — the thing the registry exists to prevent.
 */
export function readEarlierTimelinePage(response: TimelineReadResponse): EarlierTimelinePage {
  return {
    events: response.entries.map(readTimelineRowAsEvent),
    hasEarlierRows: response.hasMore,
    nextBeforeCursor: response.nextCursor,
  };
}

/**
 * One projected row, read back as the log entry it was projected from.
 *
 * The two renames are the forward boundary's: the wire's event type is `type` and
 * this projection calls it `kind`, and the row's instant is `timestamp` where the log
 * calls it `occurredAt`. `actor` carries to `actorId` verbatim and its absence stays
 * absence — the row shape has no present-`null` state to fold in, so the three-state
 * fact the forward boundary flattens arrives here already flat.
 *
 * `payload` is SPREAD rather than carried by reference. The boundary arm's payload is
 * the typed rollback event rather than the open record every other arm carries, and
 * the store's log holds a keyed record: spreading takes the members the wire sent
 * without asserting the typed shape away, and costs one object per row of a page a
 * person pressed a control to fetch.
 */
function readTimelineRowAsEvent(row: TimelineRow): ConsoleSessionEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    sequence: row.sequence,
    kind: row.type,
    occurredAt: row.timestamp,
    ...(row.actor === undefined ? {} : { actorId: row.actor }),
    payload: { ...row.payload },
  };
}
