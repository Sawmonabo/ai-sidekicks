// The one wake-up an outstanding clone deadline gets, and where the clone list reads
// its instant from.
//
// WHY A WAKE-UP AT ALL, WHEN NOTHING ELSE IN THIS SECTION HAS ONE. Every other figure
// on a repo card is an age, and an age is only ever wrong by however long ago the
// section read. The disposal countdown is not an age: it is a DEADLINE, and crossing it
// changes what the card says — from a neutral "scheduled" to the amber "past its
// disposal time, and the snapshot refs may already be gone". The section's instant is
// the stamp of its last read, so a clone that crossed `expiresAt` with no repo event, no
// window focus, and no reconnect stayed on the neutral arm for as long as the sidebar
// stayed open, which is exactly the situation a person leaves a session in.
//
// ONE TIMER FOR THE LIST, AND IT IS THE CONSOLE'S — `store/deadline-wake.ts`, which is
// where the arming rule lives for every surface that renders against a deadline rather
// than against an age. A timer per card would arm one per clone for a threshold that is
// the same sentence on each; a deadline already behind now needs no wake-up, because the
// instant the list is rendering against is already past it; and firing publishes an
// instant rather than reading anything, so this is not a refresh and does not belong to
// `store/scheduling.ts`. The hook also holds the part this module's own copy got wrong:
// a disposal scheduled more than about 24.8 days out overflows a platform timer, which
// fires on the next tick rather than late — publishing that far-future instant at once
// and rendering every clone past its deadline, permanently, with nothing left to re-arm.
// It steps to a far deadline instead. There is still no interval in this family.
//
// THE INSTANT IS THE LATER OF THE TWO, NEVER A SECOND CLOCK. The section stamps its
// reading when the read lands, and this hook can only ever move that stamp FORWARD to a
// deadline the read did not reach — so a fresh read always wins, and the ages beside the
// countdown are the read's own until it is re-read. Nothing here reads a wall clock: the
// clock is the window's, so under the fixture it is the scenario's frozen one.

import { useMemo } from "react";

import { consoleClockFor, type ConsoleBridge } from "../bridge/index.js";
import { useDeadlineWake } from "../store/index.js";
import { cloneExpiryAtMs, type EphemeralCloneStatusRecord } from "./worktree-model.js";

/**
 * Every disposal deadline this list holds, in the order the records came in.
 *
 * Which rows have one at all is `cloneExpiryAtMs`'s decision and stays here — a swept
 * or unparseable row has no deadline — and which of them is next is the wake-up's,
 * which is the split that keeps this module holding no arming rule of its own.
 */
function cloneExpiryDeadlines(records: readonly EphemeralCloneStatusRecord[]): readonly number[] {
  const deadlines: number[] = [];
  for (const record of records) {
    const deadlineMilliseconds = cloneExpiryAtMs(record);
    if (deadlineMilliseconds !== undefined) {
      deadlines.push(deadlineMilliseconds);
    }
  }
  return deadlines;
}

/**
 * The instant the clone list renders against, woken once at each outstanding deadline.
 *
 * The clock comes from the bridge rather than from a parameter, on
 * `frame/ui-state-lifecycle.ts`'s reason: `consoleClockFor` is the one answer to which
 * clock a window runs on, and a surface threading its own would be a second time base
 * beside the scenario's. It is memoised because the real arm mints a fresh `RealClock`
 * per call, and a new object every render would re-arm the timer every render.
 */
export function useCloneExpiryInstant(
  records: readonly EphemeralCloneStatusRecord[],
  readAtMilliseconds: number,
  bridge: ConsoleBridge,
): number {
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const wokeAtMilliseconds = useDeadlineWake(clock, cloneExpiryDeadlines(records));
  // The later of the two, which is what makes a fresh read always win: the wake-up can
  // only move the instant forward to a deadline the read did not reach.
  return Math.max(readAtMilliseconds, wokeAtMilliseconds);
}
