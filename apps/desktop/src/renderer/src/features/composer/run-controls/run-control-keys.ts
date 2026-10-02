// The keys the run controls hold a dispatch under: the in-flight key and the record token.
// The token is the record's own id (one admitted dispatch, one record), so a form finds its own
// settlement by it rather than by whichever record is newest.

import { type RunControl } from "./services/run-control-dispatch.js";

/** The separator between the segments of a token or key. */
const KEY_SEPARATOR = ":";

/**
 * Mints the token an admitted dispatch's record is recorded under. The run and control make
 * it legible in a failure; the ordinal keeps two dispatches of one control on one run distinct.
 */
export function mintRunControlDispatchToken(
  runId: string,
  control: RunControl,
  dispatchOrdinal: number,
): string {
  return `${runId}${KEY_SEPARATOR}${control}${KEY_SEPARATOR}${String(dispatchOrdinal)}`;
}

/** The key one in-flight dispatch is held under. One control per run at a time. */
export function inFlightKeyFor(runId: string, control: RunControl): string {
  return `${runId}${KEY_SEPARATOR}${control}`;
}
