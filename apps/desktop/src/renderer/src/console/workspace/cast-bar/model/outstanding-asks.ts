// What is still waiting on a person, read as one line the bar can render.
//
// THE LEDGER IS NOT THIS MODULE'S. `store/outstanding-asks/outstanding-ask-journal.ts` holds the
// lifecycles — which event opens a request, which terminals close it, which id it is
// keyed on — and holds them OUTSIDE the window they were learned from, because the
// store's `timeline` is one capped window over a log that may start partway through
// its session. A fold over that window loses an approval the moment its opening row is
// pruned or thrown away by the next read, and the bar prints its all-clear line over a
// run that is still blocked. That was this module's own defect, and the fix was to move
// the ledger rather than to fold more carefully.
//
// WHAT IS LEFT HERE IS THE BAR'S READING OF IT, and it is deliberately small: how many
// lifecycles are open, whom they are attributed to, and whether the ledger can answer
// at all. Those three are what the strip renders and nothing else in the console reads
// them, which is why they are derived in the cast bar's own family rather than
// published from the store as a fourth thing the register knows.

import type { OutstandingAskLedger } from "../../../store/index.js";

/**
 * What the session still has open, and how much of it the console could read.
 *
 * The COUNT is carried beside the participant set rather than derived from it,
 * because they answer different questions and the difference is load-bearing: an ask
 * the wire attributed to nobody puts no chip in amber and still means something is
 * outstanding. The all-clear line reads the count, so it can never say "nothing
 * needs you" over an unattributed ask that no chip could have shown.
 */
export interface OutstandingAsks {
  /** Participants an outstanding ask is attributed to, by its OPENING event. */
  readonly participantIds: ReadonlySet<string>;
  /** Every outstanding ask this console has read, attributed or not. */
  readonly count: number;
  /**
   * Whether requests exist below this window's head that were never read here.
   *
   * A THIRD ANSWER RATHER THAN A ZERO, which is the whole point of carrying it: the
   * count above is a count of what was read, and over a window that opened partway
   * through its log a zero means "none in what I was sent" and not "none". The bar
   * renders the difference instead of collapsing it into the all-clear line.
   */
  readonly isWindowHeadUnread: boolean;
}

/**
 * Read the ledger into the three facts the bar renders.
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
  const participantIds = new Set<string>();
  let count = 0;

  for (const request of ledger.requestsByKey.values()) {
    if (request.openedAtSequence === undefined || request.closedAtSequence !== undefined) {
      continue;
    }
    count += 1;
    if (request.opener !== undefined) {
      participantIds.add(request.opener);
    }
  }
  for (const run of ledger.runsByRunId.values()) {
    if (!run.needsAttention) {
      continue;
    }
    count += 1;
    if (run.opener !== undefined) {
      participantIds.add(run.opener);
    }
  }

  return { participantIds, count, isWindowHeadUnread: ledger.isWindowHeadUnread };
}
