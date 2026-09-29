import { memo, type MemoExoticComponent } from "react";
import { WireFigure } from "@renderer/console/primitives/index.js";
import { isAuditStubSession, type SessionListRow } from "../rows/session-rows.js";
import { SessionRowFacts } from "./SessionRowFacts.js";

export interface SessionRowProps {
  readonly row: SessionListRow;
  readonly onOpen: (sessionId: string) => void;
}

/**
 * One row.
 *
 * Memoized, so a projection read that changes one session's attention re-renders
 * that row and not its neighbors. The comparison is the default shallow one and
 * that is sufficient here: `rows` is rebuilt from the store's own references, and
 * the callback is stable for the life of the screen.
 */
export const SessionRow: MemoExoticComponent<(props: SessionRowProps) => React.JSX.Element> = memo(
  function SessionRow(props: SessionRowProps): React.JSX.Element {
    const { row } = props;
    const isAuditStub = isAuditStubSession(row.state);
    return (
      <div
        className={`meridian-session-row${isAuditStub ? " meridian-session-row--audit-stub" : ""}`}
      >
        <div className="meridian-session-row__identity">
          {isAuditStub ? (
            <span className="meridian-session-row__name">
              <WireFigure value={row.sessionId} />
            </span>
          ) : (
            <button
              type="button"
              className="meridian-session-row__name meridian-session-row__name--open"
              onClick={() => {
                props.onOpen(row.sessionId);
              }}
            >
              <WireFigure value={row.sessionId} />
            </button>
          )}
          <SessionRowFacts row={row} />
        </div>
      </div>
    );
  },
);
