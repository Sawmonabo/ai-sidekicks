// The reasoning row with its read. Its own component because hooks bind a component, not
// a tree: only a reasoning row builds a read, and the ordinary row does not pay for one.

import { useCallback } from "react";

import { type PublishedText } from "#renderer/lib/text/published.js";
import { ThinkingRow } from "./ThinkingRow.js";
import { useReasoningRead } from "./hooks/useReasoningRead.js";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

/** The props of a reasoning row with its read. */
export interface ThinkingRowWithReadProps {
  /** The run this row's reasoning belongs to, or `undefined` where none is attributed. */
  readonly runId: RunId | undefined;
  /** Text the reveal engine is publishing for this row right now, while it streams. */
  readonly liveText: PublishedText | undefined;
  /** The reasoning entry the row a read returned carries, or `undefined` on a streamed row. */
  readonly storedText: PublishedText | undefined;
  /** Hold the row where it stands while the read's answer grows it. */
  readonly holdRowInPlace: () => void;
}

/** One reasoning row, fed by its own on-demand read. */
export function ThinkingRowWithRead(props: ThinkingRowWithReadProps): React.JSX.Element {
  const reasoningRead = useReasoningRead(props.runId);
  const { holdRowInPlace } = props;
  const expand = reasoningRead.expand;
  const expandHeld = useCallback(() => {
    holdRowInPlace();
    expand();
  }, [holdRowInPlace, expand]);
  return (
    <ThinkingRow
      runId={props.runId}
      liveText={props.liveText}
      storedText={props.storedText}
      reading={reasoningRead.reading}
      onExpand={expandHeld}
    />
  );
}
