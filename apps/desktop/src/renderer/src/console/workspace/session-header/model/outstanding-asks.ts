// What is still waiting on a person, read as one line the bar can render.
//
// THE LEDGER IS NOT THIS MODULE'S. The lifecycles — which event opens a request, which
// terminals close it, which id it is keyed on — are held by
// `store/session/outstanding-asks/outstanding-ask-journal.ts`, and held OUTSIDE the
// window they were learned from, because the
// store's `timeline` is one capped window over a log that may start partway through
// its session. A fold over that window loses an approval the moment its opening row is
// pruned or thrown away by the next read, and the bar prints its all-clear line over a
// run that is still blocked. That was this module's own defect, and the fix was to move
// the ledger rather than to fold more carefully.
//
// WHAT IS LEFT HERE IS THE HEADER'S READING OF IT, and it is deliberately small: how
// many lifecycles are open, and whether the ledger can answer at all. Both are what the
// strip renders and nothing else in the console reads them, which is why they are
// derived in this family rather than published from the store as a third thing the
// register knows.

import type { OutstandingAskLedger } from "../../../store/index.js";

/** What the session still has open, and how much of it the console could read. */
export interface OutstandingAsks {
  /** Every outstanding ask this console has read, attributed or not. */
  readonly count: number;
  /**
   * Whether requests exist below this window's head that were never read here.
   *
   * A THIRD ANSWER RATHER THAN A ZERO, which is the whole point of carrying it: the
   * count above is a count of what was read, and over a window that opened partway
   * through its log a zero means "none in what I was sent" and not "none". The header
   * renders the difference instead of collapsing it into the all-clear line.
   */
  readonly isWindowHeadUnread: boolean;
}

/**
 * Read the ledger into the two facts the bar renders.
 *
 * A pure function over the register's reading rather than a class, for the reason
 * every other derivation in this family is: it holds nothing between calls, so a
 * re-read after a batch cannot disagree with a read from scratch.
 *
 * OUTSTANDING IS AN OPENER WITH NO TERMINAL, and the two positions the record carries
 * are what make that comparison order-insensitive: a backward page delivers a
 * request's terminal before its own opening row, and a rule that deleted a key on a
 * terminal would have that opener re-open a settled ask forever. A record holding only
 * a terminal is a request whose opening row is below this window's head and was never
 * recovered — settled, and correctly not counted.
 */
export function foldOutstandingAsks(ledger: OutstandingAskLedger): OutstandingAsks {
  let count = 0;

  for (const request of ledger.requestsByKey.values()) {
    if (request.openedAtSequence === undefined || request.closedAtSequence !== undefined) {
      continue;
    }
    count += 1;
  }
  for (const run of ledger.runsByRunId.values()) {
    if (run.needsAttention) {
      count += 1;
    }
  }

  return { count, isWindowHeadUnread: ledger.isWindowHeadUnread };
}
