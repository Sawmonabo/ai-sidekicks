// One person in the session: who they are, what state they are in, what they hold,
// and — behind one press — which of their devices the aggregate was folded from.
//
// FOUR FACTS ON THE LINE AND THE FIFTH ONE PRESS AWAY. Name, hue, presence state and
// role are the line; the device fan-out is not, because it is an owner/operator-only
// read and asking it for every row on mount would put an authorization question about
// every person in the session behind a panel nobody opened.
//
// THE ROLE IS READ, NEVER INFERRED. It comes from the membership rows the section
// already derives — the read where there is one, the admission beat where there is
// not — so this row does not ask a second question and cannot answer differently from
// the ledger below it. A participant whose role neither source states wears no role
// chip at all rather than a guess.
//
// THE HOLDER MARK IS A WIRE FIELD AND NOT A CLAIM THIS ROW MAKES. `Spec-023 §Console
// Design (Meridian)` 8.8 puts the terminal-control holder wherever presence renders
// and forbids deriving it from the last observed claim, so the mark is drawn from the
// holder read and from nothing else. It is a MARK and not a control: claiming and
// releasing the lease are the terminal pane's, and a second place to press them would
// be a second place to be refused.

import { useId } from "react";

import type { MembershipRole } from "@ai-sidekicks/contracts";

import { Chip, Glyph, WireFigure, formatRelativeTime } from "../../primitives/index.js";
import { GLYPH_SIZE_ROW, participantHueTokenName, tokenReference } from "../../tokens/index.js";
import type { RosterRow } from "./presence-model.js";
import type { PresenceDetailReading } from "./presence-detail.js";
import { PresenceDeviceDetail } from "./PresenceDeviceDetail.js";

export interface RosterListRowProps {
  readonly row: RosterRow;
  readonly nowMilliseconds: number;
  readonly label: string;
  readonly composingChannelId: string | undefined;
  /** This participant's role, where either source states one. */
  readonly role: MembershipRole | undefined;
  /** True when the holder read named this participant. Never derived here. */
  readonly holdsTerminalControl: boolean;
  /** True when this row's device detail is the one open. */
  readonly isDetailOpen: boolean;
  /** The detail answer, present only while this row is the open one. */
  readonly detailReading: PresenceDetailReading | undefined;
  readonly onToggleDetail: () => void;
}

export function RosterListRow(props: RosterListRowProps): React.JSX.Element {
  const { row, nowMilliseconds, label, composingChannelId, role, holdsTerminalControl } = props;
  const { participant } = row;
  const isOffline = participant.state === "offline";
  // One id per row, so the disclosure names the panel it opens rather than every row
  // naming one panel. `useId` and not the participant id: the id is a wire string and
  // a DOM id composed from one is a wire string in a place the wire never sent it.
  const detailPanelId = useId();

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
      <div className="meridian-roster-row__line">
        <span className="meridian-roster-row__mark" style={markStyle} aria-hidden="true" />
        <span className="meridian-roster-row__identity">
          <span className="meridian-roster-row__label">{label}</span>
          {row.isSelf ? <span className="meridian-roster-row__self-mark">You</span> : null}
        </span>
        <span className="meridian-roster-row__marks">
          <Chip
            label={participant.state}
            mono
            tone={PRESENCE_TONE[participant.state] ?? "neutral"}
          />
          {role === undefined ? null : (
            <Chip label={role} mono tone={role === "owner" ? "accent" : "neutral"} />
          )}
          {holdsTerminalControl ? (
            <span className="meridian-roster-row__holder">
              <Glyph name="terminal" size={GLYPH_SIZE_ROW} title="Holds the shared terminal" />
            </span>
          ) : null}
          {composingChannelId === undefined ? null : (
            <span className="meridian-roster-row__composing">
              <Glyph name="pencil" size={GLYPH_SIZE_ROW} title="Composing" />
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
        <button
          type="button"
          className="meridian-roster-row__detail-toggle"
          aria-expanded={props.isDetailOpen}
          aria-controls={detailPanelId}
          onClick={props.onToggleDetail}
        >
          <Glyph
            name={props.isDetailOpen ? "chevron-down" : "chevron-right"}
            size={GLYPH_SIZE_ROW}
            title={props.isDetailOpen ? "Hide devices" : "Show devices"}
          />
        </button>
      </div>
      {props.isDetailOpen ? (
        <div className="meridian-roster-row__detail" id={detailPanelId}>
          <PresenceDeviceDetail
            reading={props.detailReading}
            aggregateOnTheRow={participant.state}
          />
        </div>
      ) : null}
    </li>
  );
}

/** The hue a row's identity mark carries, as a `var()` reference. */
export interface IdentityMarkStyle extends React.CSSProperties {
  readonly "--meridian-roster-hue": string;
}

/** Which chip tone a presence state earns. Amber only where a person is needed. */
export const PRESENCE_TONE: Readonly<Record<string, "neutral" | "attention">> = {
  online: "neutral",
  idle: "neutral",
  // A reconnecting client is the one presence state a person may have to act on —
  // it is the state where their work may not be reaching anyone.
  reconnecting: "attention",
  offline: "neutral",
};
