// Reading one member off a projected payload, without claiming to have parsed it.
//
// `TranscriptEventRow.payload` is an open `Record<string, unknown>` on three of its four arms: a
// transcript row is a read projection that carries the event's payload through unvalidated.
// Parsing it here with the contract's schema would revalidate what the daemon already validated,
// and would fail closed on a row whose payload grew a member this build has not seen.
//
// An absent or wrongly-typed member reads as `undefined`, and nothing coerces: `String(value)`
// on an object would show `[object Object]` as a tool name. The string rule lives in
// `lib/wire/strings.ts`; a caller reads `readWireString(projectedPayload(row)["toolName"])`.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

/** The empty record a row with no open payload reads as; frozen for memoized callers. */
const NO_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * The open projected payload of a row, whatever its arm.
 *
 * `rollback_boundary` carries the typed `run.rolled_back` event instead, so the rewind cutoff is
 * never read through a cast. A reader narrows on `kind` for that arm; here it reads as the
 * empty record.
 */
export function projectedPayload(row: TranscriptEventRow): Readonly<Record<string, unknown>> {
  return row.kind === "rollback_boundary" ? NO_PAYLOAD : row.payload;
}

/**
 * A payload member that is a finite non-negative number, or `undefined`. Every numeric member a
 * card reads is a duration or byte count, so a negative one renders as absent.
 */
export function readWireCount(
  payload: Readonly<Record<string, unknown>>,
  member: string,
): number | undefined {
  const value = payload[member];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
