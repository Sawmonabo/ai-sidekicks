// Who is in this session, and what state each of them is in.
//
// A READ SURFACE AND NOTHING ELSE. There is no control here: role changes and
// invites are the members surface's, and a roster that carried either would be a
// second place to perform them. What it offers is legibility — one line per person,
// their hue, their presence, and whether they are composing right now. The one
// control it does carry acts on the READ rather than on the session: a refused
// presence stream is otherwise terminal for the life of the window, and a column
// that can only say it failed is a column a person has no way out of.
//
// EVERY ROW STAYS. An offline participant is dimmed and marked, never dropped: the
// question this surface answers is "who is in this session", and someone who
// stepped away is still in it. Dropping them would make the list shrink and grow
// under a person's eye for a reason that has nothing to do with membership.
//
// FOUR STATES, NOT FIVE. `online`, `idle`, `reconnecting`, `offline` — the wire's
// closed set. Composing is carried beside presence rather than folded into it,
// because a person can be composing on a reconnecting client and a fifth state
// would make that unrepresentable.
//
// ONE HUE PER PERSON, ALLOCATED BY THE SESSION AND NOT BY THIS LIST. The wheel is
// walked in join-log order by the store's own allocator, so the same person is the
// same colour here, in the log, and on a pane's focus ring. A participant the wheel
// has not admitted renders unattributed rather than borrowing a neighbour's colour.

import { memo } from "react";

import { DerivedFigure, Nothing, RefusalCard } from "../../primitives/index.js";
import type { ChannelActivityLabels } from "../activity-model.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import type { PresenceReading, RosterRow } from "./presence-model.js";
import { RosterListRow } from "./RosterListRow.js";

export interface RosterProps {
  readonly state: PushDrivenReadState<PresenceReading>;
  /** The read's participants, ordered and hue-attached. Derived by the caller, once. */
  readonly rows: readonly RosterRow[];
  /** The instant relative stamps are measured against — the console's clock, never the wire's. */
  readonly nowMilliseconds: number;
  readonly labels: ChannelActivityLabels;
  /** Which channel each participant is composing in, or `undefined`. */
  readonly composingChannelFor: (participantId: string) => string | undefined;
  /**
   * True when the collaboration channel has dropped.
   *
   * One line for the whole roster rather than a mark per row: the read degraded as a
   * whole, and per-row noise would suggest the console knows which people it is
   * still current about.
   */
  readonly isLastKnown: boolean;
  /**
   * Re-open the presence stream after a refusal. Rendered only on the failed arm.
   *
   * The read's own trigger rather than a rebuild of this session's models: a
   * refusal on one stream says nothing about the others, and tearing the set down
   * would re-open reads that never failed and clear the activity registry with them.
   */
  readonly onReopen: () => void;
}

/**
 * MEMOIZED, and every prop above is arranged so the memo can hit.
 *
 * The sidebar re-renders whenever any section's own state moves, and without this
 * the roster re-derived a relative age for every participant on each of those passes
 * — work whose result is identical, in a list that is one of the console's longest.
 * The memo is only as good as the identities handed in: `rows` is derived once per
 * reading, `composingChannelFor` is a subscribed reading rather than a bound method,
 * and `nowMilliseconds` moves exactly when a rendered age does.
 */
export const Roster: React.MemoExoticComponent<(props: RosterProps) => React.JSX.Element> = memo(
  function Roster(props: RosterProps): React.JSX.Element {
    const { state, rows, nowMilliseconds, labels, composingChannelFor, isLastKnown, onReopen } =
      props;

    if (state.kind === "not-loaded") {
      return (
        <div className="meridian-roster">
          <Nothing kind="not-loaded" title="Reading who is in this session." />
        </div>
      );
    }

    if (state.kind === "failed") {
      return (
        <div className="meridian-roster">
          <RefusalCard
            code={state.refusal.code}
            detail={state.refusal.detail}
            action={
              <button type="button" onClick={onReopen}>
                Try again
              </button>
            }
          />
        </div>
      );
    }

    return (
      <div className="meridian-roster">
        {isLastKnown ? (
          <p className="meridian-roster__degraded" role="status">
            <DerivedFigure text="These are the last presence readings the console received." />
          </p>
        ) : null}
        {rows.length === 0 ? (
          // Unreachable for a member, since the reader is one of the rows — which is
          // exactly why it is rendered rather than assumed away: a roster that came
          // back with nobody in it is a fact worth stating, not a blank panel.
          <Nothing
            kind="empty"
            placement="surface"
            title="Presence came back with nobody in this session."
            detail="Every member of a session appears here, including you, so an empty reading is worth telling someone about."
          />
        ) : (
          <ul className="meridian-roster__list">
            {rows.map((row) => (
              <RosterListRow
                key={row.participant.participantId}
                row={row}
                nowMilliseconds={nowMilliseconds}
                label={labels.participantLabel(row.participant.participantId)}
                composingChannelId={composingChannelFor(row.participant.participantId)}
              />
            ))}
          </ul>
        )}
      </div>
    );
  },
);
