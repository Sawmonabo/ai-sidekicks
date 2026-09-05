// What one fan-out over the invitations read produced, and what is still waiting.
//
// Split out of `InviteShelf.tsx` because it is a fold rather than a rendering: every
// function here is total over its arguments, so the cases that matter — a refusal
// beside a served answer, an invitation whose expiry has passed, a stamp the wire
// wrote that no reader can parse — are one call each instead of a mounted component
// and a frozen clock.
//
// OUTCOMES ARE TRACKED, NOT SURVIVORS. "One session has nothing for you" and
// "another would not say" are two facts, and a fold that kept only the first would
// let a served empty answer beside a refused one render as a definitive nothing.

import { parseInstant } from "../../core/index.js";
import type { ReadingState } from "../../primitives/index.js";
import type { InvitesListOutcome, InvitesListRefusal, ServedInvite } from "../../bridge/index.js";

/** What the shelf's notices call what was read. Mid-sentence, so never capitalized. */
export const SHELF_SUBJECT = "your invitations";

/**
 * The read. One outcome per session the console holds a reference to.
 *
 * An EMPTY array is meaningful and is not the same as a refusal: it means there
 * was nothing to ask about, which is the ordinary state of a console holding no
 * sessions.
 */
export type InviteShelfReader = () => Promise<readonly InvitesListOutcome[]>;

/**
 * One fan-out's answer, and the reader it was asked of.
 *
 * The reader is the identity because it IS the session set: the surface above builds
 * it from the sessions this console holds, so a set that gained or lost one is a
 * different function asking a different question. Compared by reference and not
 * reduced to a count — two sets of the same size are not the same set.
 */
export interface StampedShelfOutcomes {
  readonly reader: InviteShelfReader;
  readonly outcomes: readonly InvitesListOutcome[];
}

/** The invitations worth showing, and what the sessions that were asked answered. */
export interface ShelfReading {
  readonly pending: readonly ServedInvite[];
  /**
   * What the fan-out could not answer, in the console's own completeness vocabulary.
   *
   * `primitives/partial-read.ts` owns both the shape and the sentence, so the shelf
   * decides the one thing that is its own — the SCOPE, which follows from how many
   * sessions answered — and writes none of the words. The scope is settled here,
   * where the outcomes are counted, and never re-derived in a render body: two views
   * would eventually disagree about whether one refusal is the shelf's result or a
   * note beside one, and the disagreement would show as a refusal rendered twice or
   * not at all.
   *
   * An empty set means every session answered, which is the only state that claims
   * the shelf is showing the whole of it.
   */
  readonly states: readonly ReadingState[];
  readonly askedCount: number;
  /**
   * How many of them ANSWERED, whatever they answered with.
   *
   * The count that decides the refusal's scope, and it is deliberately not the
   * number of pending invitations that survived filtering: a session returning an
   * empty ledger, or only settled invitations, answered — and reading its answer
   * as silence would report another session's refusal as the whole shelf.
   */
  readonly servedCount: number;
}

/**
 * Merge the fan-out into one shelf.
 *
 * Deduplicated by identifier, because two sessions can carry the same invitation
 * and a shelf showing it twice would be counting rather than reading. Only
 * `pending` invitations survive: an accepted, revoked, or expired one is not
 * waiting on anybody, and the state is the wire's own word for that.
 *
 * It tracks OUTCOMES rather than survivors, which is what makes the partial-read
 * rule hold in the case that breaks it: one session answering with nothing beside
 * another that refused.
 */
export function readShelf(outcomes: readonly InvitesListOutcome[]): ShelfReading {
  const byInviteId = new Map<string, ServedInvite>();
  let refusal: InvitesListRefusal | undefined;
  let servedCount = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "unavailable") {
      refusal ??= outcome;
      continue;
    }
    servedCount += 1;
    for (const invite of outcome.value) {
      if (invite.state === "pending") {
        byInviteId.set(invite.inviteId, invite);
      }
    }
  }
  return {
    pending: [...byInviteId.values()],
    states:
      refusal === undefined
        ? []
        : [
            {
              kind: "refused",
              scope: servedCount === 0 ? "whole-answer" : "beside-an-answer",
              refusal,
            },
          ],
    askedCount: outcomes.length,
    servedCount,
  };
}

/**
 * Whether every session that was asked answered.
 *
 * The hide set prunes only against a COMPLETE read: a session that refused may
 * hold an invitation the pending list does not name, and pruning against a partial
 * answer would clear a person's set-aside invitations on the strength of a question
 * that half of the sessions never answered.
 */
export function isCompleteRead(reading: ShelfReading): boolean {
  return reading.servedCount === reading.askedCount;
}

/**
 * When each pending invitation stops working, as instants a wake-up can be armed on.
 *
 * Unreadable stamps are dropped rather than defaulted: an expiry this console cannot
 * read is not evidence that the invitation has lapsed, and a `NaN` handed to the
 * wake-up would arm a timer that fires immediately and forever. Such a row keeps
 * rendering as waiting and shows the wire's own spelling, which is the honest
 * reading of a stamp nobody here could parse.
 */
export function expiryDeadlinesOf(invites: readonly ServedInvite[]): readonly number[] {
  return invites
    .map((invite) => parseInstant(invite.expiresAt).epochMilliseconds)
    .filter((epochMilliseconds): epochMilliseconds is number => epochMilliseconds !== undefined);
}

/**
 * The invitations still waiting at `atMilliseconds`.
 *
 * The wire's `pending` is what the read SAW, and a console left open outlives it: an
 * invitation whose expiry has passed is not waiting on anybody, and going on
 * offering it is the shelf claiming something the daemon would contradict on its
 * next answer. So the expiry is read against an instant that moves — see
 * `useDeadlineWake` — rather than against the instant of the last read.
 *
 * An unreadable expiry keeps the row: the alternative is hiding an invitation on the
 * strength of a stamp this console could not read.
 */
export function stillWaitingAt(
  invites: readonly ServedInvite[],
  atMilliseconds: number,
): readonly ServedInvite[] {
  return invites.filter((invite) => {
    const expiry = parseInstant(invite.expiresAt).epochMilliseconds;
    return expiry === undefined || expiry > atMilliseconds;
  });
}
