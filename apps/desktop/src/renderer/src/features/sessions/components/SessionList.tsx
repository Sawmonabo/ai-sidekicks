// The all-sessions list: one row per session, pinned rows first.
//
// `SessionSnapshot` has no name column, so a row shows the session identifier and its users;
// the state chip carries the wire's own string. No rename, archive, close or reactivate
// control is drawn, disabled or not.
//
// Every row handed in is mounted, with no virtualization and no cap; rows are memoized, so
// one row's change re-renders one row.

import { useMemo } from "react";

import { orderSessionRows, type SessionListRow } from "../rows/session-rows.js";
import type { SessionPins } from "../rows/session-pins.js";
import { SessionRowGroup } from "./SessionRowGroup.js";

/** What the list is handed: the rows, which of them are pinned, and how to open one. */
export interface SessionListProps {
  readonly rows: readonly SessionListRow[];
  readonly pinned: SessionPins;
  /** Open a session. Renderer-local navigation. */
  readonly onOpen: (sessionId: string) => void;
}

/** The list of sessions, pinned rows first. */
export function SessionList(props: SessionListProps): React.JSX.Element {
  const { rows, pinned } = props;
  // Memoized so a render with the same rows and pins hands the group the same array.
  const ordered = useMemo(() => orderSessionRows(rows, pinned), [rows, pinned]);
  return (
    <div className="meridian-session-list">
      <SessionRowGroup label="Sessions" rows={ordered} onOpen={props.onOpen} />
    </div>
  );
}
