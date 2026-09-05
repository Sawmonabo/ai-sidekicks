import { useMemo } from "react";
import { DerivedFigure } from "../primitives/index.js";
import { SessionList } from "./SessionList.js";
import { SessionsAbsence } from "./SessionsAbsence.js";
import { mergeSessionRows, withAttentionSeverity } from "./rows/session-directory-rows.js";
import type { SessionListRow } from "./rows/session-rows.js";
import { countSentence, severityReaderFor, type SessionRowsProps } from "./SessionsSurface.js";

/**
 * The list itself, once all three sources have been named.
 *
 * The directory still answers on an address that names no session — it is a node read
 * and not a session read — which is what lets this surface tell a window holding
 * nothing apart from a node holding nothing, and report the first as the first.
 */
export function SessionRowsView(props: SessionRowsProps): React.JSX.Element {
  const { attention, directory, projectedRows, windowSessionIds } = props;
  const rows = useMemo<readonly SessionListRow[]>(
    () =>
      withAttentionSeverity(
        mergeSessionRows({ directory, windowSessionIds, projectedRows }),
        severityReaderFor(attention),
      ),
    [attention, directory, windowSessionIds, projectedRows],
  );

  if (rows.length === 0) {
    return <SessionsAbsence directory={directory} action={props.startControl} />;
  }
  return (
    <>
      <p className="meridian-sessions__count">
        <DerivedFigure text={countSentence(rows.length, directory)} />
      </p>
      <SessionList
        rows={rows}
        tierBySessionId={props.pins.tiers}
        onOpen={props.onOpen}
        onSetTier={props.pins.setTier}
      />
      {props.startControl}
    </>
  );
}
