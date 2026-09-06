import { useMemo } from "react";
import { DerivedFigure } from "../primitives/index.js";
import { SessionList } from "./SessionList.js";
import { SessionsAbsence } from "./SessionsAbsence.js";
import { mergeSessionRows, withAttentionSeverity } from "./rows/session-directory-rows.js";
import type { SessionListRow } from "./rows/session-rows.js";
import { type AttentionSeverity } from "../bridge/index.js";
import type { SessionDirectoryState } from "../seats/index.js";
import { formatCount } from "../primitives/index.js";
import { type AttentionReading } from "./notifications/index.js";
import { type SessionPinBinding } from "./rows/session-pins.js";
import { type ReactNode } from "react";

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

/** What the list is handed: the node's answer, this window's set, and its projection. */
export interface SessionRowsProps {
  readonly directory: SessionDirectoryState;
  readonly windowSessionIds: readonly string[];
  /** What every open session's store can describe, from `open-session-rows.ts`. */
  readonly projectedRows: readonly SessionListRow[];
  readonly attention: AttentionReading;
  readonly pins: SessionPinBinding;
  readonly startControl: ReactNode;
  readonly onOpen: (sessionId: string) => void;
}

/**
 * How one reading answers "what does this session need attention for".
 *
 * A factory rather than a lambda written inside the memo, for {@link sessionIdOf}'s
 * reason: the reading is the argument, and the session is the returned function's.
 */
export function severityReaderFor(
  attention: AttentionReading,
): (sessionId: string) => AttentionSeverity | undefined {
  return (sessionId) =>
    attention.phase === "read" ? attention.plane.severityFor(sessionId) : undefined;
}

/**
 * What the count says, and whose count it is.
 *
 * The sentence names the AUTHORITY, not just the number: a list the node answered
 * for is the node's count, and a list assembled from what this window happens to
 * hold is this window's. Reporting the second in the first's words would be the
 * surface's one remaining chance to overclaim.
 */
export function countSentence(rowCount: number, directory: SessionDirectoryState): string {
  if (directory.status === "served") {
    return rowCount === 1
      ? "One session is on this node."
      : `${formatCount(rowCount)} sessions are on this node.`;
  }
  return rowCount === 1
    ? "One session is open in this console."
    : `${formatCount(rowCount)} sessions are open in this console.`;
}
