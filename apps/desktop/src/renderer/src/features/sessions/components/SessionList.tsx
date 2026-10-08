// The all-sessions list: one row per session, pinned rows first. Every row handed in is
// mounted; rows are memoized, so one row's change re-renders one row, and every row's age
// advances together on the list's one beat.

import "./SessionList.css";

import { useMemo } from "react";

import { useAgesNow } from "#renderer/hooks/useAgesNow.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";

import { orderSessionRows, type SessionListRow } from "../rows/list-row.js";
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
  const nowMilliseconds = useAgesNow(
    useClock(),
    ordered.flatMap((row) => (row.touchedAtIso === undefined ? [] : [row.touchedAtIso])),
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
