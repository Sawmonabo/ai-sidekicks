import { type SessionListRow } from "./rows/session-rows.js";
import { SessionRow } from "./SessionRow.js";

/** A labeled list of session rows. */
export function SessionRowGroup(props: {
  readonly label: string;
  readonly rows: readonly SessionListRow[];
  readonly onOpen: (sessionId: string) => void;
}): React.JSX.Element {
  return (
    <ul className="meridian-session-list__rows" aria-label={props.label}>
      {props.rows.map((row) => (
        <li key={row.sessionId}>
          <SessionRow row={row} onOpen={props.onOpen} />
        </li>
      ))}
    </ul>
  );
}
