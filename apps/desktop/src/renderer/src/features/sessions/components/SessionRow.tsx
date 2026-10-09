import "./SessionRow.css";

import { memo, type MemoExoticComponent } from "react";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { sessionDisplayTitleOf } from "#renderer/store/session/directory/display-title.js";
import { isSessionBeingDeleted, type SessionListRow } from "../rows/list-row.js";
import { SessionRowFacts } from "./SessionRowFacts.js";

/** What a session row is handed: the row, how to open it, and the instant its age is read at. */
export interface SessionRowProps {
  readonly row: SessionListRow;
  readonly onOpen: (sessionId: string) => void;
  /** The instant the row's age is drawn against, on the list's one beat. */
  readonly nowMilliseconds: number;
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
    const displayTitle = sessionDisplayTitleOf(row);
    // A session nothing names, not even by its shape, is told apart by its id.
    const title =
      displayTitle === undefined ? (
        <WireFigure value={row.sessionId} />
      ) : displayTitle.isUntitled ? (
        <span className="meridian-session-row__untitled">{displayTitle.text}</span>
      ) : (
        displayTitle.text
      );
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
          <SessionRowFacts row={row} nowMilliseconds={props.nowMilliseconds} />
        </div>
      </div>
    );
  },
);
