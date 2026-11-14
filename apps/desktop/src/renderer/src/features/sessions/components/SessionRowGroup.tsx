import { formatAge } from "#renderer/lib/wire/figures.js";
import { drawnSessionActivityOf, type SessionListRow } from "../rows/list-row.js";
import { SessionRow } from "./SessionRow.js";

/** A labeled list of session rows, each handed its age and activity as drawn at one instant. */
export function SessionRowGroup(props: {
  readonly label: string;
  readonly rows: readonly SessionListRow[];
  readonly onOpen: (sessionId: string) => void;
  /** The instant the rows' ages and activity are drawn at, on the list's one beat. */
  readonly nowMilliseconds: number;
}): React.JSX.Element {
  const { nowMilliseconds } = props;
  return (
    <ul className="meridian-session-list__rows" aria-label={props.label}>
      {props.rows.map((row) => (
        <li key={row.sessionId}>
          <SessionRow
            row={row}
            onOpen={props.onOpen}
            age={
              row.touchedAtIso === undefined
                ? undefined
                : formatAge(row.touchedAtIso, nowMilliseconds)
            }
            activity={drawnSessionActivityOf(row, nowMilliseconds)}
          />
        </li>
      ))}
    </ul>
  );
}
