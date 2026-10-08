import { type SessionListRow } from "../rows/list-row.js";
import { SessionRow } from "./SessionRow.js";

/** A labeled list of session rows. */
export function SessionRowGroup(props: {
  readonly label: string;
  readonly rows: readonly SessionListRow[];
  readonly onOpen: (sessionId: string) => void;
  /** The instant the rows' ages are drawn against, on the list's one beat. */
  readonly nowMilliseconds: number;
}): React.JSX.Element {
  return (
    <ul className="meridian-session-list__rows" aria-label={props.label}>
      {props.rows.map((row) => (
        <li key={row.sessionId}>
          <SessionRow row={row} onOpen={props.onOpen} nowMilliseconds={props.nowMilliseconds} />
        </li>
      ))}
    </ul>
  );
}
