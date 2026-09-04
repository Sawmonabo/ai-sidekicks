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
// ONE TIMER FOR THE LIST, AT THE EARLIEST DEADLINE STILL AHEAD OF NOW —
// `attachment-carrier.ts`'s stall wake-up in this same family, and every word of it is
// load-bearing here too. A timer per card would arm one per clone for a threshold that
// is the same sentence on each; a deadline already behind now needs no wake-up, because
// the instant the list is rendering against is already past it; and firing publishes an
// instant rather than reading anything, so this is not a refresh and does not belong to
// `store/scheduling.ts`. When it fires it lands back here and re-arms for the next
// deadline: a chain of single shots that stops on its own the moment nothing is
// outstanding. There is still no interval in this family, and there can be none.
//
// THE INSTANT IS THE LATER OF THE TWO, NEVER A SECOND CLOCK. The section stamps its
// reading when the read lands, and this hook can only ever move that stamp FORWARD to a
// deadline the read did not reach — so a fresh read always wins, and the ages beside the
// countdown are the read's own until it is re-read. Nothing here reads a wall clock: the
// clock is the window's, so under the fixture it is the scenario's frozen one.

import { useEffect, useMemo, useState } from "react";

import { consoleClockFor, type ConsoleBridge } from "../bridge/index.js";
import { cloneExpiryAtMs, type EphemeralCloneStatusRecord } from "./worktree-model.js";

/**
 * The soonest disposal deadline still ahead of the instant given, or `undefined`.
 *
 * Pure and exported, so the arming rule is provable by driving it rather than by
 * reaching into the hook below. A row whose deadline has already passed is skipped
 * because the card is rendering its elapsed arm as this runs, and a swept or unparseable
 * row has no deadline at all — `cloneExpiryAtMs` is the one place that decides which.
 */
export function earliestCloneExpiryDeadlineMs(
  records: readonly EphemeralCloneStatusRecord[],
  nowMilliseconds: number,
): number | undefined {
  let earliestMilliseconds: number | undefined;
  for (const record of records) {
    const deadlineMilliseconds = cloneExpiryAtMs(record);
    if (deadlineMilliseconds === undefined || deadlineMilliseconds <= nowMilliseconds) {
      continue;
    }
    if (earliestMilliseconds === undefined || deadlineMilliseconds < earliestMilliseconds) {
      earliestMilliseconds = deadlineMilliseconds;
    }
  }
  return earliestMilliseconds;
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
  const [wokeAtMilliseconds, setWokeAtMilliseconds] = useState(readAtMilliseconds);
  const nowMilliseconds = Math.max(readAtMilliseconds, wokeAtMilliseconds);
  useEffect(() => {
    const deadlineMilliseconds = earliestCloneExpiryDeadlineMs(records, nowMilliseconds);
    if (deadlineMilliseconds === undefined) {
      return;
    }
    const handle = clock.scheduleTimeout(() => {
      // The deadline itself and not the clock's reading of now: the card's own arm
      // turns on whether that instant has passed, and waking to a later one would put
      // an instant on screen no threshold in this list corresponds to.
      setWokeAtMilliseconds(deadlineMilliseconds);
    }, deadlineMilliseconds - clock.now());
    return () => {
      // Cancelled when the record set changes, when the wake-up has landed, and when
      // the section unmounts — a timeout that outlived its surface would set state on a
      // component that is gone.
      clock.cancel(handle);
    };
  }, [records, nowMilliseconds, clock]);
  return nowMilliseconds;
}
