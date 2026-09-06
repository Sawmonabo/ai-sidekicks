import { type PlacedSessionRow, type SessionPinTier } from "./rows/session-rows.js";
import { SessionRow } from "./SessionRow.js";

export function SessionRowGroup(props: {
  readonly label: string;
  readonly rows: readonly PlacedSessionRow[];
  readonly onOpen: (sessionId: string) => void;
  readonly onSetTier: (sessionId: string, tier: SessionPinTier) => void;
}): React.JSX.Element {
  return (
    <ul className="meridian-session-list__rows" aria-label={props.label}>
      {props.rows.map((row) => (
        <li key={row.sessionId}>
          <SessionRow row={row} onOpen={props.onOpen} onSetTier={props.onSetTier} />
        </li>
      ))}
    </ul>
  );
}
