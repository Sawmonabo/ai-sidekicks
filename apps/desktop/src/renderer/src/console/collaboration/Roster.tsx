// Who is in this session, and what state each of them is in.
//
// A READ SURFACE AND NOTHING ELSE. There is no control here: role changes and
// invites are the members surface's, and a roster that carried either would be a
// second place to perform them. What it offers is legibility — one line per person,
// their hue, their presence, and whether they are composing right now.
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

import type { PresenceReadResponseParticipant } from "@ai-sidekicks/contracts";

import {
  Chip,
  DerivedFigure,
  Glyph,
  Nothing,
  RefusalCard,
  WireFigure,
  formatRelativeTime,
} from "../primitives/index.js";
import { participantHueTokenName, tokenReference } from "../tokens/index.js";
import type { ChannelActivityLabels } from "./activity-model.js";
import type { PushDrivenReadState } from "./push-driven-read.js";
import type { RosterRow } from "./presence-model.js";

export interface RosterProps {
  readonly state: PushDrivenReadState<readonly PresenceReadResponseParticipant[]>;
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
}

/** Which chip tone a presence state earns. Amber only where a person is needed. */
const PRESENCE_TONE: Readonly<Record<string, "neutral" | "attention">> = {
  online: "neutral",
  idle: "neutral",
  // A reconnecting client is the one presence state a person may have to act on —
  // it is the state where their work may not be reaching anyone.
  reconnecting: "attention",
  offline: "neutral",
};

const ROSTER_GLYPH_SIZE = 12;

export function Roster(props: RosterProps): React.JSX.Element {
  const { state, rows, nowMilliseconds, labels, composingChannelFor, isLastKnown } = props;

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
        <RefusalCard code={state.refusal.code} detail={state.refusal.detail} />
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
}

interface RosterListRowProps {
  readonly row: RosterRow;
  readonly nowMilliseconds: number;
  readonly label: string;
  readonly composingChannelId: string | undefined;
}

/** The hue a row's identity mark carries, as a `var()` reference. */
interface IdentityMarkStyle extends React.CSSProperties {
  readonly "--meridian-roster-hue": string;
}

function RosterListRow(props: RosterListRowProps): React.JSX.Element {
  const { row, nowMilliseconds, label, composingChannelId } = props;
  const { participant } = row;
  const isOffline = participant.state === "offline";

  // Fail-closed, exactly as the ledger row does it: a participant the session's
  // wheel has not admitted takes the neutral boundary rather than whichever colour
  // a fallback step would have produced, because a borrowed hue attributes this
  // person's rows to somebody else everywhere hue is read.
  const markStyle: IdentityMarkStyle = {
    "--meridian-roster-hue":
      row.hue === undefined
        ? tokenReference("edge-strong")
        : tokenReference(participantHueTokenName(row.hue.step)),
  };

  const className = [
    "meridian-roster-row",
    `meridian-roster-row--${row.hue?.ringTreatment ?? "solid"}`,
    isOffline ? "meridian-roster-row--offline" : "",
    row.isSelf ? "meridian-roster-row--self" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

  return (
    <li className={className}>
      <span className="meridian-roster-row__mark" style={markStyle} aria-hidden="true" />
      <span className="meridian-roster-row__identity">
        <span className="meridian-roster-row__label">{label}</span>
        {row.isSelf ? <span className="meridian-roster-row__self-mark">You</span> : null}
      </span>
      <span className="meridian-roster-row__marks">
        <Chip label={participant.state} mono tone={PRESENCE_TONE[participant.state] ?? "neutral"} />
        {composingChannelId === undefined ? null : (
          <span className="meridian-roster-row__composing">
            <Glyph name="pencil" size={ROSTER_GLYPH_SIZE} title="Composing" />
            <WireFigure value={composingChannelId} />
          </span>
        )}
      </span>
      <span className="meridian-roster-row__seen">
        <WireFigure
          value={formatRelativeTime(participant.lastSeen, nowMilliseconds)}
          title={participant.lastSeen}
        />
      </span>
    </li>
  );
}
