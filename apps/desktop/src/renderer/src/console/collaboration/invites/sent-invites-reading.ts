// The sent-invite ledger's read line: when it asks again, and which answer may land.
//
// SPLIT FROM `SentInvites.tsx` ON THE LINE `pending-invite-reading.ts` DRAWS BESIDE
// `pending-invite.ts`. That file is the surface — a form, a ledger, and the one act a
// person can still perform on a row — and this is the reading it draws. What moved is
// everything with a lifetime: the held answer, the read line it arrives on, the two
// things that make the answer stale, and the settlement that overtakes it.
//
// THE READS ON THIS LINE OVERLAP, AND UNTIL THIS MODULE EXISTED NOTHING ORDERED THEM.
// Three separate things ask this ledger again — a mint, a pending row crossing its
// expiry, and the surface being re-addressed — and every one of them settled through
// one publisher with no stamp on it. So the last answer to ARRIVE won, which is not
// the same as the newest one asked: a mint whose read overtook the read it displaced
// showed the minted row and was then overwritten by the pre-mint snapshot, and an
// expiry re-read that answered first left the row saying `pending` under an answer
// that had already stopped being true. Both are invisible — a correct-looking ledger
// composed from a reply the console had already superseded.
//
// SO EVERY READ IS STAMPED WHERE IT IS ISSUED. `store/read-cancellation.ts` is the
// console's one mechanism for that, and it is the whole pairing rather than half of
// it: a round is the generation claim AND the signal as one value, so a read on this
// line cannot be ordered without also being stoppable. Opening a round supersedes
// whatever round the line had open, so an older read installs nothing — measured
// against the round that issued it rather than against the value on screen, which is
// what makes an out-of-order settlement a no-op instead of a race nobody can see.
// There is no second counter here and no `isCurrent` flag of this family's own.
//
// AND THE REVOKE RECEIPT OPENS A ROUND OF ITS OWN, which is the decision this module
// makes rather than inherits. `invite.revoke` answers `{inviteId, state}` — the row
// itself, which `invite-ledger.ts` says is why no second read is put — so a settled
// revoke is the NEWEST answer this line has about that row, and it arrives on the
// line as one. That is what protects it from a refresh issued BEFORE it: the read
// that was already in flight is superseded by the receipt exactly as it would be by a
// newer read, so it can no longer restore the row to pending.
//
// THE ALTERNATIVE WAS A RECEIPT REGISTER, AND IT IS WORSE ON THE PROPERTY THAT
// MATTERS. Folding held receipts over each incoming read would keep both answers and
// need a second authority to reconcile them — a table of settlements with no natural
// end, re-applied over every later read for the life of the window, so a row the
// daemon itself later reports differently would go on being overwritten by a receipt
// nobody could retire. One value, one line, one newest answer: what this surface holds
// is the holder's, and what may write into it is the round's. The read the receipt
// discards is strictly older than the receipt on the one row the two can disagree
// about, and whatever else it carried is asked for again by the next mint or expiry.
//
// WHAT IS DELIBERATELY NOT HERE IS A SCHEDULER. `store/scheduling.ts` is where a
// periodic re-read would go and there is no periodic re-read: nothing on this line
// polls, a mint and a crossed expiry are each one act at one moment, and the fixture's
// clock is frozen — a debounce window under it would never elapse at all, so a read
// behind one would never be performed. `useDeadlineWake` arms the console's one
// single-shot timer at the earliest outstanding expiry and arms nothing once no row is
// pending, which is the whole of the timing this reading has.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { InviteRevokeResponse } from "@ai-sidekicks/contracts";

import { consoleClockFor, expiryDeadlinesOf, type ConsoleBridge } from "../../bridge/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import {
  isReadAbandoned,
  settleUnlessAbandoned,
  useDeadlineWake,
  useReadScope,
  useSubjectScopedState,
} from "../../store/index.js";
import {
  partitionInvites,
  withSettledInvite,
  type InviteLedger,
  type LedgerReading,
} from "./invite-ledger.js";

/** Names this read in a refusal the call itself did not name. */
const SENT_INVITES_ORIGIN = "sent-invites";

/** What the sent-invite surface draws, and the two things that move it. */
export interface SentInviteLedgerReading {
  /** The answer this line currently holds. `undefined` until one lands. */
  readonly reading: LedgerReading | undefined;
  /** That answer partitioned, where it was served. `undefined` on every other arm. */
  readonly ledger: InviteLedger | undefined;
  /**
   * Say that this session has just minted an invitation, so the ledger asks again.
   *
   * `InviteCreateResponse` carries no `state` and no `joinMode`, so a row folded in
   * from it would be two members the wire did not send — the opposite of the receipt
   * below, whose reply IS the row.
   */
  readonly noteMinted: () => void;
  /**
   * Fold one settled revocation in, as the newest answer this line has.
   *
   * It opens a round, so a read issued before it installs nothing afterwards. Without
   * that, a refresh already on the wire when the revoke settled restored the row to
   * `pending` — with its control offered again — over a reply the daemon had already
   * given, and nothing on screen said so.
   */
  readonly applySettledRevoke: (settlement: InviteRevokeResponse) => void;
}

export function useSentInviteLedger(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): SentInviteLedgerReading {
  // One `invitesList` answer, held against the exact subject it was asked of.
  //
  // The bridge is the subject and the session is the key, because a window handed a
  // replacement bridge for the same session is holding an answer from a transport
  // that no longer exists, and the ledger's own control would dispatch through the
  // replacement while showing the retired one's rows.
  //
  // Through the family's one holder rather than a `useState` and a render-time pair
  // comparison: the pair is EQUAL on the first and third visit of an A to B to A
  // round-trip and the holder's addressing is not, so the hand-written version rested
  // on a per-effect-run flag whose correctness was not the holder's — a second copy of
  // the primitive this family had just rebound onto.
  const { value: reading, publish: publishReading } = useSubjectScopedState<
    LedgerReading | undefined
  >(bridge, sessionId, () => undefined);
  // The read line, addressed at the same pairing the value is, so the two begin and
  // end together: a surface re-addressed at a new session gets a fresh line and the
  // session it left has its outstanding read abandoned in the same render.
  const readScope = useReadScope(bridge, sessionId);
  // How many times a person has minted an invitation here. Bumped by the form and
  // read by the effect below, which is what makes the ledger re-ask after an act —
  // a counter rather than a boolean, so two mints in a row both re-read.
  const [mintCount, setMintCount] = useState(0);

  const ledger = useMemo(
    () =>
      reading?.kind === "answered" && reading.outcome.status === "served"
        ? partitionInvites(reading.outcome.value)
        : undefined,
    [reading],
  );

  // The clock this window runs on, and not a second one. `consoleClockFor` mints a
  // fresh `RealClock` per call, so it is memoised on the bridge — a new object every
  // render would re-arm the timer every render, and under the fixture the clock this
  // resolves to is the scenario's frozen one, which is what lets a case advance to an
  // expiry rather than wait for it.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  // Only a PENDING row has a lifetime left to run: every other `InviteState` is
  // terminal, so arming on a settled row's expiry would wake to re-ask a question
  // whose answer cannot move. Re-derived from each ledger, so a read that returns a
  // new pending row arms for it and one that returns none arms nothing.
  const expiryDeadlines = useMemo(() => expiryDeadlinesOf(ledger?.pending ?? []), [ledger]);
  // Consumed as a READ TRIGGER rather than as an instant to render against, which is
  // what separates this surface from the shelf and the clone list: those compare a
  // moving instant to a threshold they hold, and this one holds no threshold — the
  // row's `state` is the wire's word. So the instant enters the effect below as a
  // dependency, and crossing an expiry re-asks. It cannot loop: the wake publishes
  // the deadline it crossed, and every expiry at or behind that instant is one
  // `useDeadlineWake` arms nothing for.
  const wokeAtMilliseconds = useDeadlineWake(clock, expiryDeadlines);

  useEffect(() => {
    // One read on mount, one more each time this session mints an invitation, and one
    // at each pending row's expiry. Nothing else re-asks: there is no interval here
    // and no signal on this wire to wake on, so the only other thing that changes this
    // ledger is the revoke receipt below, whose own reply IS the row it changed.
    if (sessionId === undefined) {
      return;
    }
    // OPENING THE ROUND IS THE SUPERSESSION, and it happens before the request is
    // composed: from here on this is the only read on this line whose answer may
    // land, and any earlier one is over whether or not it has reached the wire.
    const round = readScope.openRound();
    // A round born over, which is React's double-mount rather than anything exotic:
    // the scope's own effect commits first, so its strict-mode cleanup abandons the
    // scope that THIS render captured. A growth read ignores the signal by design, so
    // there is no call door beneath to refuse the request and the reading is taken
    // here — the alternative is a request nothing can ever stop.
    if (isReadAbandoned(round.signal)) {
      return;
    }
    void settleUnlessAbandoned(bridge.growth.invitesList({ sessionId }), round.signal).then(
      (settlement) => {
        if (settlement.status === "abandoned") {
          return;
        }
        // The round rather than the publisher alone. The publisher drops an answer
        // whose SUBJECT moved; this drops one whose round was superseded under a
        // subject that did not move, which is every overlap on this line.
        round.settle(() => {
          publishReading({ kind: "answered", outcome: settlement.value });
        });
      },
      // The port's contract is that it RESOLVES with an outcome, so a rejection has
      // no arm in that vocabulary. Left unhandled it published nothing and the
      // ledger went on saying "Reading this session's invitations" for the life of
      // the window over a call that had already failed. It is stamped like the
      // answer it stands in for: a failure from a superseded read must not replace
      // a newer read's rows with a refusal.
      (rejection: unknown) => {
        round.settle(() => {
          publishReading({
            kind: "unreadable",
            refusal: consoleRefusalFrom(rejection, SENT_INVITES_ORIGIN),
          });
        });
      },
    );
    // `wokeAtMilliseconds` is a dependency and never read in the body: it names WHEN
    // to ask again, not what to ask. It moves at a crossed expiry and when the clock
    // itself is replaced, and at no other time — never per render, and never because
    // the ledger was rebuilt — so the steady state here is still one read.
    // `readScope` re-identifies on exactly the occasions `publish` does.
  }, [bridge, sessionId, publishReading, readScope, mintCount, wokeAtMilliseconds]);

  const noteMinted = useCallback(() => {
    setMintCount((count) => count + 1);
  }, []);

  const applySettledRevoke = useCallback(
    (settlement: InviteRevokeResponse) => {
      readScope.openRound().settle(() => {
        // Published through the holder's own updater, so the subject check is the
        // holder's: a settlement arriving after a re-address is dropped rather than
        // folded into whichever ledger is on screen now.
        publishReading((held) => {
          const settled = withSettledInvite(held, settlement);
          // `undefined` here would mean the ledger held no answer at all, and by
          // this point it does; identity means the settlement named no row it holds.
          // Both leave the ledger exactly as it stands.
          return settled ?? held;
        });
      });
    },
    [readScope, publishReading],
  );

  return { reading, ledger, noteMinted, applySettledRevoke };
}
