// What the session header may claim about whether anything needs the user.
//
// THE ONE RULE THIS MODULE EXISTS FOR. The all-clear line is a CLAIM: it says the
// console read everything it could and found nothing outstanding. Two conditions make
// that claim false in different ways, and collapsing them into one boolean is what put
// the line over a run that was still blocked. So the standing is three-valued and the
// ordering below is the honest one.
//
// A pure module. It derives; it holds nothing.

import { foldOutstandingAsks } from "./outstanding-asks.js";
import type { OutstandingAskLedger } from "../../../store/index.js";

/**
 * What the header may claim about whether anything needs a person — three answers,
 * not two.
 *
 *   • `attention` — something IS outstanding, or the console has no standing to say
 *     otherwise. A degraded projection is here beside a real block, because a store
 *     with a sequence gap cannot know whether something needs answering; so is the
 *     node's health verdict, which is an amber mark this fold cannot see and which a
 *     line printed beside it would contradict.
 *   • `earlier-unread` — nothing is outstanding in what the console WAS SENT, and there
 *     are rows it was not sent. A session's stream replays from the position this
 *     window was last acknowledged at, so a resumed window starts partway through its
 *     log and the request lifecycles below its head have no base-state carrier to be
 *     seeded from. Zero read is not zero, and this is the arm that says so.
 *   • `all-clear` — read everything, found nothing.
 */
export type SessionHeaderStanding = "all-clear" | "earlier-unread" | "attention";

/** Everything the header derives, in one pass. */
export interface SessionHeaderModel {
  readonly standing: SessionHeaderStanding;
  /**
   * How many asks are still open, from the register that outlives the window.
   *
   * Carried beside the standing rather than folded into it, because the two answer
   * different questions: `attention` is also reached by a degraded projection and by an
   * unwell node, and neither of those is an ask. The header renders the figure only
   * where there is one.
   */
  readonly outstandingAskCount: number;
}

export interface SessionHeaderInput {
  /**
   * What the session still has open, from the register that outlives the window.
   *
   * An INPUT rather than a fold over the timeline, because the answer is not in the
   * timeline: a session's stream replays from the position this window was last
   * acknowledged at, and the window is capped besides, so an approval raised below the
   * head or pruned at the cap is in no fold's reach.
   * `store/session/outstanding-asks/outstanding-ask-journal.ts` holds those lifecycles
   * across every window replacement; this model reads them.
   */
  readonly outstandingAsks: OutstandingAskLedger;
  /** True while the store is degraded, which withdraws the all-clear claim. */
  readonly isDegraded: boolean;
  /**
   * True while the header's health verdict counts a component that is not healthy.
   *
   * Passed in rather than read here, because health is a node measurement served over
   * the wire and this module folds the session's own register — but the all-clear line
   * speaks for the whole strip, including the mark that measurement draws.
   */
  readonly isNodeUnwell: boolean;
}

/** Build the header's reading. */
export function deriveSessionHeader(input: SessionHeaderInput): SessionHeaderModel {
  const outstanding = foldOutstandingAsks(input.outstandingAsks);
  if (input.isDegraded || input.isNodeUnwell || outstanding.count > 0) {
    // ATTENTION WINS, and it wins over `earlier-unread` deliberately: a session with a
    // block the console DID read has nothing to gain from a sentence about rows it did
    // not, and the two lines together would leave a reader deciding which is the news.
    return { standing: "attention", outstandingAskCount: outstanding.count };
  }
  return {
    standing: outstanding.isWindowHeadUnread ? "earlier-unread" : "all-clear",
    outstandingAskCount: 0,
  };
}
