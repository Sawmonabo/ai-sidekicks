// The all-sessions list: one row per session, pinned rows first. Every row handed in is
// mounted; rows are memoized and handed what they draw, so a row re-renders only when its own
// drawing changes. Every row's age and activity advance on the list's one beat, one timer at most,
// armed for the next moment any row would draw differently and armed again when the rows change.

import "./SessionList.css";

import { useMemo } from "react";

import { useDrawnInstant } from "#renderer/hooks/useDrawnInstant.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";

import { orderSessionRows, sessionRowsChangeAt, type SessionListRow } from "../rows/list-row.js";
import type { SessionPins } from "../rows/pins.js";
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
  const nowMilliseconds = useDrawnInstant(useClock(), ordered, (instant) =>
    sessionRowsChangeAt(ordered, instant),
  );
  return (
    <div className="meridian-session-list">
      <SessionRowGroup
        label="Sessions"
        rows={ordered}
        onOpen={props.onOpen}
        nowMilliseconds={nowMilliseconds}
      />
    </div>
  );
}
