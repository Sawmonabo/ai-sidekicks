// The keys the run controls hold a dispatch under: the in-flight key and the record token.
// The token is the record's own id (one admitted dispatch, one record), so a form finds its own
// settlement by it rather than by whichever record is newest.

import { structuralKey } from "#renderer/lib/structural-key.js";
import { type RunControl } from "./services/dispatch.js";

/** What one dispatch acts on: a run, or one child of it named by the daemon's handle. */
export interface RunControlSubject {
  readonly runId: string;
  readonly childHandle?: string | undefined;
}

/**
 * Mints the token an admitted dispatch's record is recorded under. The run and control make
 * it legible in a failure; the ordinal keeps two dispatches of one control on one run distinct.
 */
export function mintRunControlDispatchToken(
  runId: string,
  control: RunControl,
  dispatchOrdinal: number,
): string {
  return structuralKey([runId, control, String(dispatchOrdinal)]);
}

/**
 * The key one in-flight dispatch is held under: one control per run, or per child of a run, at a
 * time, so a steer to one child never holds back a steer to its sibling.
 */
export function inFlightKeyFor(subject: RunControlSubject, control: RunControl): string {
  return subject.childHandle === undefined
    ? structuralKey([subject.runId, control])
    : structuralKey([subject.runId, subject.childHandle, control]);
}
