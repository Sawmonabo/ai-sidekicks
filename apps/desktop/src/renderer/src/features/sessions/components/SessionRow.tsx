import "./SessionRow.css";

import type { SessionActivity } from "@ai-sidekicks/contracts/session/directory";
import { memo, type MemoExoticComponent } from "react";
import { STATUS_DOT_WORDS, StatusDot } from "#renderer/components/StatusDot/StatusDot.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { sessionDisplayTitleOf } from "#renderer/store/session/directory/display-title.js";
import { isSessionBeingDeleted, type SessionListRow } from "../rows/list-row.js";
import { SessionRowFacts } from "./SessionRowFacts.js";

/** What a session row is handed: the row, how to open it, and what it draws on the list's beat. */
export interface SessionRowProps {
  readonly row: SessionListRow;
  readonly onOpen: (sessionId: string) => void;
  /** The row's age as drawn on the list's beat, or `undefined` for a row with no touched-at. */
  readonly age: string | undefined;
  /** The row's activity as drawn on the list's beat, or `undefined` for a row the list lacks. */
  readonly activity: SessionActivity | undefined;
}

/**
 * One session row, memoized so it re-renders only when its own drawing changes.
 * The default shallow comparison suffices: `rows` reuses the store's references, the age and
 * activity are strings, and the callback is stable for the life of the screen.
 */
export const SessionRow: MemoExoticComponent<(props: SessionRowProps) => React.JSX.Element> = memo(
  function SessionRow(props: SessionRowProps): React.JSX.Element {
    const { row, activity } = props;
    const isBeingDeleted = isSessionBeingDeleted(row.state);
    const displayTitle = sessionDisplayTitleOf(row);
    // A session nothing names, not even by its shape, is told apart by its id.
    const shownTitle =
      displayTitle === undefined ? (
        <WireFigure value={row.sessionId} />
      ) : displayTitle.isUntitled ? (
        <span className="meridian-session-row__untitled">{displayTitle.text}</span>
      ) : (
        displayTitle.text
      );
    // The dot is hidden from assistive technology, so the row's name ends in its state's word.
    const title = (
      <>
        {shownTitle}
        {activity === undefined ? null : (
          <span className="meridian-visually-hidden"> {STATUS_DOT_WORDS[activity]}</span>
        )}
      </>
    );
    return (
      <div
        className={`meridian-session-row${isBeingDeleted ? " meridian-session-row--deleting" : ""}`}
      >
        <div className="meridian-session-row__identity">
          {activity === undefined ? null : (
            <span className="meridian-session-row__dot">
              <StatusDot state={activity} />
            </span>
          )}
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
          <SessionRowFacts row={row} age={props.age} />
        </div>
      </div>
    );
  },
);
