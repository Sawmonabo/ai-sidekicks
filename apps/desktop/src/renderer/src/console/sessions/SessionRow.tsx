import { memo, type MemoExoticComponent } from "react";
import { WireFigure } from "../primitives/index.js";
import {
  isAuditStubSession,
  type PlacedSessionRow,
  type SessionPinTier,
} from "./rows/session-rows.js";
import { SessionRowFacts } from "./SessionRowFacts.js";
import { SessionRowMenu } from "./SessionRowMenu.js";

export interface SessionRowProps {
  readonly row: PlacedSessionRow;
  readonly onOpen: (sessionId: string) => void;
  readonly onSetTier: (sessionId: string, tier: SessionPinTier) => void;
}

/**
 * One row.
 *
 * Memoised, so a projection read that changes one session's attention re-renders
 * that row and not its neighbours. The comparison is the default shallow one and
 * that is sufficient here: `rows` is rebuilt from the store's own references, and
 * both callbacks are stable for the life of the surface.
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
        {/* An audit stub gets no controls at all. It is a retention record rather
          than work, and the retention read-out is another surface's. */}
        {isAuditStub ? null : (
          <SessionRowMenu sessionId={row.sessionId} tier={row.tier} onSetTier={props.onSetTier} />
        )}
      </div>
    );
  },
);
