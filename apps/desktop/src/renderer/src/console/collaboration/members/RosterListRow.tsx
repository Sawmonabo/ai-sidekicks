import { Chip, Glyph, WireFigure, formatRelativeTime } from "../../primitives/index.js";
import { participantHueTokenName, tokenReference } from "../../tokens/index.js";
import type { RosterRow } from "./presence-model.js";
import { PRESENCE_TONE, ROSTER_GLYPH_SIZE, type IdentityMarkStyle } from "./Roster.js";

export interface RosterListRowProps {
  readonly row: RosterRow;
  readonly nowMilliseconds: number;
  readonly label: string;
  readonly composingChannelId: string | undefined;
}

export function RosterListRow(props: RosterListRowProps): React.JSX.Element {
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
