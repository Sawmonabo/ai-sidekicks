// The token one admitted dispatch's record is held under.
//
// `run-control-surface.ts` mints the token when it admits a dispatch, and it is the
// record's own id: one admitted dispatch appends exactly one record, so the token
// identifies the request and a form finds its own settlement by it rather than by
// whichever record is newest. The run and the control ride it so a token is legible in
// a test failure and in a debugger; the ordinal is the surface's monotonic dispatch
// counter, which keeps two dispatches of one control on one run distinct.

import { type RunControl } from "./run-control-dispatch.js";

/** The separator between the token's three segments. */
const TOKEN_SEPARATOR = ":";

/**
 * Mint the token an admitted dispatch's record will be recorded under.
 *
 * The run and the control ride it so a token is legible in a test failure and in a
 * debugger.
 */
export function mintRunControlDispatchToken(
  runId: string,
  control: RunControl,
  dispatchOrdinal: number,
): string {
  return `${runId}${TOKEN_SEPARATOR}${control}${TOKEN_SEPARATOR}${String(dispatchOrdinal)}`;
}
