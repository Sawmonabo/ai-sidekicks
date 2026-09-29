import { Chip } from "@renderer/components/Chip/Chip.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";
import { type SessionListRow } from "../rows/session-rows.js";

/**
 * A row's facts, including the instant it was last touched.
 *
 * THAT INSTANT CARRIES ITS DAY. The list has no day divider, so a clock-only reading
 * made a session touched an hour ago and one touched last week at the same minute the
 * same eight characters, and the sort order was the only thing left saying which was
 * which. `formatDateTime` exists for exactly the view that has no other carrier of
 * the day, and says so in its own words.
 */
export function SessionRowFacts(props: { readonly row: SessionListRow }): React.JSX.Element {
  const { row } = props;
  return (
    <div className="meridian-session-row__facts">
      {row.state === undefined ? (
        <Nothing
          kind="not-checked"
          title="No state"
          detail="The wire named none for this session."
        />
      ) : (
        <Chip label={row.state} mono />
      )}
      {row.attentionSeverity === undefined ? null : (
        <Chip
          tone={row.attentionSeverity === "actionable" ? "attention" : "neutral"}
          label={row.attentionSeverity === "actionable" ? "Needs you" : "Something happened"}
        />
      )}
      {row.touchedAtIso === undefined ? null : (
        <WireFigure value={formatDateTime(row.touchedAtIso)} title={row.touchedAtIso} />
      )}
      {row.userIds.length === 0 ? null : (
        <span className="meridian-session-row__users">
          {row.userIds.map((userId) => (
            <WireFigure key={userId} value={userId} />
          ))}
        </span>
      )}
    </div>
  );
}
