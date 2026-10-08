import { Chip } from "#renderer/components/Chip/Chip.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { formatAge, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { type SessionListRow } from "../rows/list-row.js";

/** A row's facts. The touched-at instant reads as its age, with its zoned time as the hover. */
export function SessionRowFacts(props: {
  readonly row: SessionListRow;
  /** The instant the age is drawn against, on the list's one beat. */
  readonly nowMilliseconds: number;
}): React.JSX.Element {
  const clockLocale = useClockLocale();
  const { row } = props;
  const { touchedAtIso } = row;
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
      {touchedAtIso === undefined ? null : (
        <WireFigure
          value={formatAge(touchedAtIso, props.nowMilliseconds)}
          hoverLabel={formatZonedDateTime(touchedAtIso, clockLocale)}
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
