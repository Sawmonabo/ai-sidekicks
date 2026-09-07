// The token one admitted dispatch's record is held under: minted here, read here.
//
// BOTH SIDES OF ONE SEAM IN ONE MODULE, which is why this is a file and not two
// template literals. `run-control-surface.ts` mints the token when it admits a
// dispatch and `run-control-reading.ts` reads the ordinal back out of it to rank one
// run's settlements; a mint in one file and a parse in another are two copies of one
// encoding, and two copies of an encoding drift the day either side grows a segment.
//
// WHAT THE ORDINAL IS FOR. Records are appended when their promises SETTLE, and a
// surface admits different controls for one run concurrently, so append order is
// completion order and not request order. A later dispatch answering `run.not_found`
// and an earlier one answering successfully afterwards leaves the older answer newest
// in the array — which read as the run being back. The ordinal is the surface's own
// monotonic dispatch counter, so it orders the REQUESTS and the late settlement of an
// older one cannot supersede a newer verdict.
//
// AND IT IS THE RECORD'S ID RATHER THAN A SECOND MEMBER BESIDE IT. One admitted
// dispatch appends exactly one record, so the token already identifies the request;
// carrying the ordinal a second time as its own field would be two stored copies of
// one number, free to disagree. It is carried once, in the token, and read back
// through the function below.

import { type RunControl } from "./run-control-dispatch.js";

/**
 * The first ordinal a surface allocates.
 *
 * `1` rather than `0` because the surface increments before it mints, and it is
 * exported so a reader ranking an unreadable token has a floor to sit below rather
 * than a magic number of its own.
 */
export const FIRST_RUN_CONTROL_DISPATCH_ORDINAL = 1;

/** The separator between the token's three segments. */
const TOKEN_SEPARATOR = ":";

/**
 * Mint the token an admitted dispatch's record will be recorded under.
 *
 * The run and the control ride it so a token is legible in a test failure and in a
 * debugger; the ordinal is the part anything reads back.
 */
export function mintRunControlDispatchToken(
  runId: string,
  control: RunControl,
  dispatchOrdinal: number,
): string {
  return `${runId}${TOKEN_SEPARATOR}${control}${TOKEN_SEPARATOR}${String(dispatchOrdinal)}`;
}

/**
 * The dispatch ordinal a token carries, or `undefined` where it carries none.
 *
 * Read from the LAST separator rather than by splitting into three: `control` is a
 * closed set of six literals none of which carries the separator, and the ordinal is
 * digits, so the final segment is unambiguous even for a run id that carries one.
 * Anything else — a token minted by something other than the function above — reads
 * as absent rather than as a number, and the caller ranks it below every real ordinal
 * instead of guessing one.
 */
export function runControlDispatchOrdinalOf(recordId: string): number | undefined {
  const separatorAt = recordId.lastIndexOf(TOKEN_SEPARATOR);
  if (separatorAt <= 0) {
    return undefined;
  }
  const trailing = recordId.slice(separatorAt + TOKEN_SEPARATOR.length);
  if (!/^[0-9]+$/.test(trailing)) {
    return undefined;
  }
  const ordinal = Number(trailing);
  return Number.isSafeInteger(ordinal) && ordinal >= FIRST_RUN_CONTROL_DISPATCH_ORDINAL
    ? ordinal
    : undefined;
}
