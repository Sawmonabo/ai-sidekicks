// The all-sessions list: one row per session, pinned rows first.
//
// What the rows may and may not claim is the whole of this file's difficulty, and
// four rules carry it:
//
//   • **No invented name.** `SessionSnapshot` has `config` and `metadata` bags and
//     no name column, so a session renders by its identifier and its users.
//     The identifier is a wire figure and wears the mono provenance signature; a
//     console-composed title beside it would be prose paraphrasing a figure.
//   • **State verbatim.** The chip carries the wire's own string in mono. The
//     console classifies it exactly once — to know whether the row is an audit stub
//     — and never re-words it.
//   • **No control without a verb.** Rename, archive, close, and reactivate are not
//     drawn. Drawing them disabled would be the same capability claim with a tooltip
//     on it.
//   • **Attention is read, never counted.** The severity on a row comes from the
//     attention projection. A row the projection did not mention shows nothing,
//     which is not the same as showing "clear".
//
// NO VIRTUALIZATION AND NO FIXED CAP. Every row the list is handed is mounted, so the
// mounted rows grow with the sessions the console holds. A constant would be a number
// picked rather than measured. Rows are memoized, so a change to one row's attention
// re-renders one row.

import { useMemo } from "react";

import { orderSessionRows, type SessionListRow } from "../rows/session-rows.js";
import type { SessionPinMap } from "@renderer/console/sessions/rows/session-pins.js";
import { SessionRowGroup } from "./SessionRowGroup.js";

/** What the list is handed: the rows, which of them are pinned, and how to open one. */
export interface SessionListProps {
  readonly rows: readonly SessionListRow[];
  readonly pinned: SessionPinMap;
  /** Open a session. Renderer-local navigation. */
  readonly onOpen: (sessionId: string) => void;
}

/** The list of sessions, pinned rows first. */
export function SessionList(props: SessionListProps): React.JSX.Element {
  const { rows, pinned } = props;
  // Under `useMemo` so a list re-rendered by a neighbour's attention change does not
  // sort again.
  const ordered = useMemo(() => orderSessionRows(rows, pinned), [rows, pinned]);
  return (
    <div className="meridian-session-list">
      <SessionRowGroup label="Sessions" rows={ordered} onOpen={props.onOpen} />
    </div>
  );
}
