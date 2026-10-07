import "./SessionRow.css";

import { memo, type MemoExoticComponent } from "react";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { isSessionBeingDeleted, type SessionListRow } from "../rows/list-row.js";
import { SessionRowFacts } from "./SessionRowFacts.js";

/** What a session row is handed: the row and how to open it. */
export interface SessionRowProps {
  readonly row: SessionListRow;
  readonly onOpen: (sessionId: string) => void;
}

/**
 * One session row, memoized so one session's change re-renders only that row.
 * The default shallow comparison suffices: `rows` reuses the store's references and the
 * callback is stable for the life of the screen.
 */
export const SessionRow: MemoExoticComponent<(props: SessionRowProps) => React.JSX.Element> = memo(
  function SessionRow(props: SessionRowProps): React.JSX.Element {
    const { row } = props;
    const isBeingDeleted = isSessionBeingDeleted(row.state);
    // A session the list has not named is told apart by its id.
    const title = row.name ?? <WireFigure value={row.sessionId} />;
    return (
      <div
        className={`meridian-session-row${isBeingDeleted ? " meridian-session-row--deleting" : ""}`}
      >
        <div className="meridian-session-row__identity">
          {isBeingDeleted ? (
            <span className="meridian-session-row__name">{title}</span>
          ) : (
            <button
              type="button"
              className="meridian-session-row__name meridian-session-row__name--open"
              onClick={() => {
                props.onOpen(row.sessionId);
              }}
            >
              {title}
            </button>
          )}
          <SessionRowFacts row={row} />
        </div>
      </div>
    );
  },
);
