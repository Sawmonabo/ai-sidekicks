import { Chip } from "#renderer/components/Chip/Chip.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { formatDateTime, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { type SessionListRow } from "../rows/list-row.js";

/**
 * A row's facts. The touched-at instant carries its day (`formatDateTime`), because the list
 * has no day divider and a clock-only reading would look the same across days; its hover label
 * adds the zone.
 */
export function SessionRowFacts(props: { readonly row: SessionListRow }): React.JSX.Element {
  const clockLocale = useClockLocale();
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
        <Chip label={codeWords(row.state)} />
      )}
      {row.touchedAtIso === undefined ? null : (
        <WireFigure
          value={formatDateTime(row.touchedAtIso, clockLocale)}
          hoverLabel={formatZonedDateTime(row.touchedAtIso, clockLocale)}
        />
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
