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
// WHAT IT OFFERS, AND WHAT IT CANNOT. **Not now** is a local hide: `InviteState`
// on the wire is exactly `pending | accepted | revoked | expired` and its contract
// states that declining is implicit in V1, so there is no decline verb to call and
// the shelf does not pretend there is. Accepting is not offered either, and for a
// wire reason rather than a policy one: the shipped accept view takes an invite
// TOKEN, and an invite summary carries an identifier, a state, and an expiry — the
// console has no read that hands it a token, so an accept control here would be a
// button with nothing to pass.

import { useEffect, useMemo, useState } from "react";

import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatClockTime,
  formatCount,
} from "../primitives/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import type { UiStateStore } from "../persistence/index.js";
import { useHiddenInvites } from "./hidden-invites.js";

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

export interface InviteShelfProps {
  readonly read: InviteShelfReader;
  /** The durable store the hide set is written through. */
  readonly uiStateStore: UiStateStore;
}

/** The invitations worth showing, and the refusal to render when none could be read. */
interface ShelfReading {
  readonly pending: readonly ReceivedInvite[];
  readonly refusal: InvitesListRefusal | undefined;
  readonly askedCount: number;
}

/**
 * Merge the fan-out into one shelf.
 *
 * Deduplicated by identifier, because two sessions can carry the same invitation
 * and a shelf showing it twice would be counting rather than reading. Only
 * `pending` invitations survive: an accepted, revoked, or expired one is not
 * waiting on anybody, and the state is the wire's own word for that.
 */
function readShelf(outcomes: readonly InvitesListOutcome[]): ShelfReading {
  const byInviteId = new Map<string, ReceivedInvite>();
  let refusal: InvitesListRefusal | undefined;
  for (const outcome of outcomes) {
    if (outcome.status === "unavailable") {
      refusal ??= outcome;
      continue;
    }
    for (const invite of outcome.value) {
      if (invite.state === "pending") {
        byInviteId.set(invite.inviteId, invite);
      }
    }
  }
  return {
    pending: [...byInviteId.values()],
    // A refusal is reported only when NOTHING was served. One session's refusal
    // beside another's answer is a partial read, and reporting it as the shelf's
    // state would hide the invitations that did arrive.
    refusal: byInviteId.size === 0 ? refusal : undefined,
    askedCount: outcomes.length,
  };
}

export function InviteShelf(props: InviteShelfProps): React.JSX.Element {
  const { read } = props;
  const [outcomes, setOutcomes] = useState<readonly InvitesListOutcome[] | undefined>(undefined);
  const hidden = useHiddenInvites(props.uiStateStore);
  const { pruneAgainst } = hidden;

  useEffect(() => {
    // One read, on mount. No interval and no scheduler: the wire behind this seam
    // refuses today, so a repeat would re-ask a question with no answer, and the
    // console's one refresh chokepoint is where a real re-read will go.
    let isAttached = true;
    void read().then((result) => {
      if (isAttached) {
        setOutcomes(result);
      }
    });
    return () => {
      isAttached = false;
    };
  }, [read]);

  const reading = useMemo(
    () => (outcomes === undefined ? undefined : readShelf(outcomes)),
    [outcomes],
  );

  useEffect(() => {
    if (reading === undefined || reading.refusal !== undefined) {
      // A refused or unasked read is not evidence that an invitation is gone, so
      // it prunes nothing. Pruning against it would clear the whole hide set on a
      // wire that never answered.
      return;
    }
    pruneAgainst(reading.pending.map((invite) => invite.inviteId));
    // The hide set is a dependency, not just an input: it arrives from the durable
    // store on its own schedule, and a read that settled first would otherwise
    // prune an empty set and never look again. `pruneAgainst` writes nothing when
    // nothing changed, so the re-run this admits terminates on its first pass.
  }, [reading, hidden.hiddenInviteIds, pruneAgainst]);

  const visible = (reading?.pending ?? []).filter(
    (invite) => !hidden.hiddenInviteIds.includes(invite.inviteId),
  );
  const setAsideCount = (reading?.pending.length ?? 0) - visible.length;

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
            {(reading?.pending ?? [])
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
  if (reading.refusal !== undefined) {
    return <InlineRefusal {...reading.refusal} />;
  }
  if (props.visible.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="Nothing is waiting for you to join."
        detail="An invitation appears here while it is pending, with the date it stops working."
      />
    );
  }
  return (
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
  );
}

/**
 * One invitation.
 *
 * The action is one button whose label is the act, because both acts this shelf
 * has — setting aside and bringing back — are local and reversible, and a control
 * that is safe to press twice needs no confirmation between the presses.
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
        <WireFigure value={formatClockTime(invite.expiresAt)} title={invite.expiresAt} />
      </div>
      <button type="button" className="meridian-invite-shelf__row-action" onClick={props.onAct}>
        {props.actionLabel}
      </button>
    </div>
  );
}
