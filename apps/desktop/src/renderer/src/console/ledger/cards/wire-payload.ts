// Reading one member off a projected payload, without claiming to have parsed it.
//
// `TimelineRow.payload` is `Record<string, unknown>` on three of its four arms, by
// contract and on purpose: a timeline row is a read projection, so the projector
// carries the originating event's payload through without re-validating it. A card
// that wants the tool's name is therefore asking an open record for a member, and the
// only two honest answers are "a string is there" and "nothing usable is there".
//
// WHY NOT PARSE THE PAYLOAD WITH ITS SCHEMA. `ToolActivityPayload` and
// `AssistantOutputPayload` have Zod schemas in `@ai-sidekicks/contracts`, and running
// one here would be a SECOND validation of bytes the daemon already validated and
// signed — and it would fail closed on a row whose payload grew a member this console's
// pinned contracts version has not seen, which is the one thing a read projection must
// never do. Two typed readers over an open record is the whole of what a card needs.
//
// FAIL-CLOSED, in the console's own sense: an absent or wrongly-typed member reads as
// `undefined`, and every caller renders the named absence rather than a placeholder.
// Nothing here coerces — `String(value)` on an object would put `[object Object]` on
// the screen and call it a tool name.

import type { TimelineRow } from "@ai-sidekicks/contracts";

/**
 * The empty record a row with no open payload reads as. One frozen value, so a caller
 * that memoizes on it is not handed a new identity every render.
 */
const NO_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * The open projected payload of a row, whatever its arm.
 *
 * Three of the four `TimelineRow` arms carry `Record<string, unknown>`; the fourth,
 * `rollback_boundary`, carries the TYPED `run.rolled_back` event instead — deliberately,
 * so the rewind cutoff can never be read through a cast. A card reading a boundary's
 * cutoff narrows on `kind` and reads the typed member directly, so the two open readers
 * below see the empty record for that arm rather than a widened type that would make the
 * typed payload readable as an untyped bag.
 */
export function projectedPayload(row: TimelineRow): Readonly<Record<string, unknown>> {
  return row.kind === "rollback_boundary" ? NO_PAYLOAD : row.payload;
}

/** A payload member that is a string, or `undefined`. */
export function readWireString(
  payload: Readonly<Record<string, unknown>>,
  member: string,
): string | undefined {
  const value = payload[member];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A payload member that is a finite non-negative number, or `undefined`.
 *
 * The range check is part of the read rather than the caller's job: every numeric
 * member a card reads today is a duration or a byte count, both of which are
 * non-negative by contract, and a negative one is a defect the card should render as an
 * absence rather than as a figure.
 */
export function readWireCount(
  payload: Readonly<Record<string, unknown>>,
  member: string,
): number | undefined {
  const value = payload[member];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
