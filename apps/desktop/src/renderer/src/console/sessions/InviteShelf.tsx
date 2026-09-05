// The received-invite shelf: invitations waiting on the sessions destination.
//
// WHAT IT READS. The growth port's `invitesList`, which is the only invites read
// the console has — `Plan-023 §Console growth slate` files it under the
// `invites-list` row, owned by Spec-002, and the live bridge answers every call to
// it with a typed refusal. The shelf renders that refusal verbatim rather than an
// empty shelf, because "the invites read is not registered" and "you have no
// invitations" are different facts.
//
// The request is session-scoped, so the surface fans the read out over the
// sessions this console holds references to and hands the shelf the outcomes. With
// no sessions held there is nothing to ask about and the shelf says so — again as
// the "not checked" absence, since the console did not put the question.
//
// AN ANSWER BELONGS TO THE READER THAT PRODUCED IT. The reader IS the session set:
// a session opening or closing hands this component a new one, which starts a fresh
// fan-out over the sessions the console holds now. The outcomes from the previous
// set keep describing the previous set until that fan-out settles — and if the
// replacement read stalls, indefinitely — so an unstamped shelf shows a definitive
// empty inbox, or another session set's invitations, for a question this console has
// already replaced. So the outcomes are held WITH the reader they were asked of and
// rendered only while it is still the reader: the first render under a new one is
// the `not-loaded` absence, which is the honest reading of a set nothing has been
// read for yet. `collaboration/SentInvites.tsx` stamps its own answer with the
// subject it was asked of for the same reason, and reads the stamp at RENDER time
// rather than trusting the effect that installed it — an effect's state lands one
// committed frame after the render that renamed its inputs, and that frame is the
// one this has to get right.
//
// WHAT IT OFFERS, AND WHAT IT CANNOT. **Not now** is a local hide: `InviteState`
// on the wire is exactly `pending | accepted | revoked | expired` and its contract
// states that declining is implicit in V1, so there is no decline verb to call and
// the shelf does not pretend there is. Accepting is not offered either, and for a
// wire reason rather than a policy one: the shipped accept view takes an invite
// TOKEN, and an invite summary carries an identifier, a state, and an expiry — the
// console has no read that hands it a token, so an accept control here would be a
// button with nothing to pass.

import { useEffect, useMemo, useState } from "react";

import { parseInstant, type ConsoleClock } from "../core/index.js";
import {
  Chip,
  InlineRefusal,
  Nothing,
  PartialRead,
  WireFigure,
  formatCount,
  formatDateTime,
  type ReadingState,
} from "../primitives/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import type { UiStateStore } from "../persistence/index.js";
import { useDeadlineWake } from "../store/index.js";
import { useHiddenInvites } from "./hidden-invites.js";

/** What the shelf's notices call what was read. Mid-sentence, so never capitalized. */
const SHELF_SUBJECT = "your invitations";

/**
 * What one `invitesList` call answers.
 *
 * Derived off the port rather than restated: the bridge door exports the bridge
 * and not the port's vocabulary, and a hand-written copy of an outcome shape would
 * be a second declaration that nothing checks against the first.
 */
type InvitesListOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["invitesList"]>>;

/** One invitation as the port serves it. */
export type ReceivedInvite = Extract<
  InvitesListOutcome,
  { readonly status: "served" }
>["value"][number];

/** The refusal arm. A `ConsoleRefusal`, so it renders through the one refusal grammar. */
type InvitesListRefusal = Extract<InvitesListOutcome, { readonly status: "unavailable" }>;

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
interface StampedShelfOutcomes {
  readonly reader: InviteShelfReader;
  readonly outcomes: readonly InvitesListOutcome[];
}

export interface InviteShelfProps {
  readonly read: InviteShelfReader;
  /** The durable store the hide set is written through. */
  readonly uiStateStore: UiStateStore;
  /**
   * The clock the expiry wake-up is armed on.
   *
   * A prop rather than a context read, on this component's own standing shape: it
   * performs no bridge call and takes every dependency it has from the surface that
   * mounts it, which is what lets a case drive it on frozen time with no provider
   * above it. `consoleClockFor` is where a caller gets one.
   */
  readonly clock: ConsoleClock;
}

/** The invitations worth showing, and what the sessions that were asked answered. */
interface ShelfReading {
  readonly pending: readonly ReceivedInvite[];
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
function readShelf(outcomes: readonly InvitesListOutcome[]): ShelfReading {
  const byInviteId = new Map<string, ReceivedInvite>();
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
function isCompleteRead(reading: ShelfReading): boolean {
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
function expiryDeadlinesOf(invites: readonly ReceivedInvite[]): readonly number[] {
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
function stillWaitingAt(
  invites: readonly ReceivedInvite[],
  atMilliseconds: number,
): readonly ReceivedInvite[] {
  return invites.filter((invite) => {
    const expiry = parseInstant(invite.expiresAt).epochMilliseconds;
    return expiry === undefined || expiry > atMilliseconds;
  });
}

export function InviteShelf(props: InviteShelfProps): React.JSX.Element {
  const { read } = props;
  const [stamped, setStamped] = useState<StampedShelfOutcomes | undefined>(undefined);
  const hidden = useHiddenInvites(props.uiStateStore);
  const { pruneAgainst } = hidden;

  useEffect(() => {
    // One read per reader. No interval and no scheduler: the wire behind this seam
    // refuses today, so a repeat would re-ask a question with no answer, and the
    // console's one refresh chokepoint is where a real re-read will go.
    let isAttached = true;
    void read().then((result) => {
      if (isAttached) {
        setStamped({ reader: read, outcomes: result });
      }
    });
    return () => {
      isAttached = false;
    };
  }, [read]);

  const outcomes = stamped !== undefined && stamped.reader === read ? stamped.outcomes : undefined;

  const reading = useMemo(
    () => (outcomes === undefined ? undefined : readShelf(outcomes)),
    [outcomes],
  );

  // One wake-up per outstanding expiry, on the console's one deadline mechanism.
  // Without it the shelf renders against the instant of its last read for as long as
  // the window stays open, which is exactly how a person leaves a session — and the
  // rows below turn on whether that instant has passed.
  const wokeAtMilliseconds = useDeadlineWake(
    props.clock,
    useMemo(() => expiryDeadlinesOf(reading?.pending ?? []), [reading]),
  );
  const waiting = useMemo(
    () => stillWaitingAt(reading?.pending ?? [], wokeAtMilliseconds),
    [reading, wokeAtMilliseconds],
  );

  useEffect(() => {
    if (reading === undefined || !isCompleteRead(reading)) {
      // A read that any session did not answer is not evidence that an invitation
      // is gone, so it prunes nothing — stated as the condition it is rather than
      // inferred from the refusal field, which is a different question.
      return;
    }
    // Against what is still WAITING rather than everything the read returned: an
    // invitation that lapsed while this console held it is gone whichever way a
    // person had filed it, so leaving its hide entry behind would keep a dead
    // identifier in a durable set forever.
    pruneAgainst(waiting.map((invite) => invite.inviteId));
    // The hide set is a dependency, not just an input: it arrives from the durable
    // store on its own schedule, and a read that settled first would otherwise
    // prune an empty set and never look again. `pruneAgainst` writes nothing when
    // nothing changed, so the re-run this admits terminates on its first pass.
  }, [reading, waiting, hidden.hiddenInviteIds, pruneAgainst]);

  const visible = waiting.filter((invite) => !hidden.hiddenInviteIds.includes(invite.inviteId));
  const setAsideCount = waiting.length - visible.length;

  return (
    <section className="meridian-invite-shelf" aria-label="Invitations">
      <h2 className="meridian-invite-shelf__title">Invitations</h2>
      {hidden.lastRefusal === undefined ? null : <InlineRefusal {...hidden.lastRefusal} />}
      <ShelfBody reading={reading} visible={visible} onSetAside={hidden.hide} />
      {setAsideCount === 0 ? null : (
        <details className="meridian-invite-shelf__fold">
          <summary className="meridian-invite-shelf__fold-summary">
            {`${formatCount(setAsideCount)} set aside`}
          </summary>
          <ul className="meridian-invite-shelf__rows">
            {waiting
              .filter((invite) => hidden.hiddenInviteIds.includes(invite.inviteId))
              .map((invite) => (
                <li key={invite.inviteId}>
                  <InviteRow
                    invite={invite}
                    actionLabel="Bring it back"
                    onAct={() => {
                      hidden.reveal(invite.inviteId);
                    }}
                  />
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ShelfBody(props: {
  readonly reading: ShelfReading | undefined;
  readonly visible: readonly ReceivedInvite[];
  readonly onSetAside: (inviteId: string) => void;
}): React.JSX.Element {
  const { reading } = props;
  if (reading === undefined) {
    return <Nothing kind="not-loaded" placement="surface" title="Reading your invitations." />;
  }
  if (reading.askedCount === 0) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No invitations have been read."
        detail="The invites read is scoped to a session, and this console is holding none — so it has not asked. This is not an empty inbox."
      />
    );
  }
  // The notice comes FIRST and the rows follow it, which is the console's own rule
  // for a reading that is not the whole of it: what a notice withdraws is the claim
  // that the rows are all of it, so it can never be read as a footnote to them.
  //
  // A refusal that is the WHOLE answer takes the rows away with it — nothing
  // answered, so there is nothing an empty state could honestly say. Anything else
  // renders under whatever the sessions that DID answer produced, an empty shelf
  // included, since "one session has nothing for you and another would not say" is
  // two facts and the shelf owes a person both of them.
  return (
    <>
      <PartialRead states={reading.states} subject={SHELF_SUBJECT} />
      {reading.servedCount === 0 ? null : props.visible.length === 0 ? (
        <Nothing
          kind="empty"
          placement="surface"
          title="Nothing is waiting for you to join."
          detail="An invitation appears here while it is pending, with the date it stops working."
        />
      ) : (
        <ul className="meridian-invite-shelf__rows">
          {props.visible.map((invite) => (
            <li key={invite.inviteId}>
              <InviteRow
                invite={invite}
                actionLabel="Not now"
                onAct={() => {
                  props.onSetAside(invite.inviteId);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * One invitation.
 *
 * The action is one button whose label is the act, because both acts this shelf
 * has — setting aside and bringing back — are local and reversible, and a control
 * that is safe to press twice needs no confirmation between the presses.
 *
 * The expiry carries its DATE. This shelf has no day divider, so the ledger's
 * date-free clock reading would render two invitations expiring days apart
 * identically — while the empty-state copy beside it promises the date the
 * invitation stops working. The raw instant stays on `title` as the verbatim wire
 * value, but it is hover-only and reaches nobody reading with a keyboard or a
 * screen reader, so it is a second copy rather than the answer.
 */
function InviteRow(props: {
  readonly invite: ReceivedInvite;
  readonly actionLabel: string;
  readonly onAct: () => void;
}): React.JSX.Element {
  const { invite } = props;
  return (
    <div className="meridian-invite-shelf__row">
      <div className="meridian-invite-shelf__row-facts">
        <WireFigure value={invite.inviteId} />
        <Chip label={invite.state} mono />
        <WireFigure value={formatDateTime(invite.expiresAt)} title={invite.expiresAt} />
      </div>
      <button type="button" className="meridian-invite-shelf__row-action" onClick={props.onAct}>
        {props.actionLabel}
      </button>
    </div>
  );
}
