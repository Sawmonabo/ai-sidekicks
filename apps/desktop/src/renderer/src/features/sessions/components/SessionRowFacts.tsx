import { Chip } from "#renderer/components/Chip/Chip.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "#renderer/lib/wire/figures.js";
import { type SessionListRow } from "../rows/session-rows.js";

/**
 * A row's facts. The touched-at instant carries its day (`formatDateTime`), because the list
 * has no day divider and a clock-only reading would look the same across days.
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
