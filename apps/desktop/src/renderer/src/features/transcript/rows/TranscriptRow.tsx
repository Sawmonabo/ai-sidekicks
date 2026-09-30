// The transcript's row renderer: one row through the card its kind names. It holds no state: a
// disclosure press writes density to the list's retained row state, because the virtualizer
// unmounts rows scrolled out of range. A `TimelineRow` carries no body, so machine rows render
// the named absence `MessageContent` and `ToolOutput` give an unread body. A type the kind table
// does not name draws nothing.

import { useCallback, useState } from "react";

import { useRetainedRowState } from "../viewport/hooks/useRetainedRowState.js";
import { useRowReveal } from "../reveal/hooks/useRowReveal.js";
import { type TranscriptRowDensity, type TranscriptRowProps } from "../transcript-row-renderer.js";
import { findTranscriptRowFooterRenderer } from "../transcript-row-footer-renderer.js";
import { FootnoteRegistry } from "./markdown/footnotes/footnote-registry.js";
import { MessageRow } from "./MessageRow.js";
import { classifyTranscriptRow } from "./row-kind.js";
import { BoundThinkingRow } from "./thinking/BoundThinkingRow.js";
import { reasoningRunIdOf } from "./thinking/reasoning-reading.js";
import { ToolRow } from "./ToolRow.js";

/**
 * One row, through the card its kind names. The classifier decides once and this switch spends
 * the answer, so the glyph, label and layout match what the cards read anywhere else.
 */
export function TranscriptRow(props: TranscriptRowProps): React.JSX.Element | null {
  const [footnotes] = useState(() => new FootnoteRegistry());
  const rowLease = useRetainedRowState();
  const rowId = props.row.id;
  const density: TranscriptRowDensity = props.density;
  // The toggle inverts the density the row was handed (the list's answer with the lease overlaid)
  // and writes it to the list, not to local state, which would die when the virtualizer unmounts
  // the row. `innerScrollTopPx` is zero because this row keeps no inner scroll of its own.
  const toggleDensity = useCallback(() => {
    rowLease.setLease(rowId, {
      density: density === "expanded" ? "collapsed" : "expanded",
      innerScrollTopPx: 0,
    });
  }, [density, rowId, rowLease]);

  const rowKind = classifyTranscriptRow(props.row);
  // The reasoning read is armed in the component that renders it, not here: an ordinary row would
  // build a reading for a control it does not draw, and on a mounted window that per-row
  // machinery was the frame a streaming lane spent and the heap a long-open window kept. Only the
  // pure read the branch turns on stays here.
  const attributedRunId = reasoningRunIdOf(props.row);
  // The live-text lane is the row, matching `MessageContent`'s `liveText`: keying on the run
  // would give two machine rows of one turn one body. It arrives through the per-row reveal
  // channel, not the renderer's props, and is `undefined` for every row of a settled log.
  const liveText = useRowReveal(rowId);

  if (rowKind === undefined) {
    return null;
  }
  switch (rowKind.kind) {
    case "tool-call":
      return (
        <ToolRow
          row={props.row}
          actorHue={props.actorHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          {...(liveText === undefined ? {} : { liveText })}
          onDensityToggle={toggleDensity}
          toolKindRenderer={undefined}
        />
      );
    case "user-message":
    case "agent-message":
    case "thinking":
      return (
        <MessageRow
          row={props.row}
          rowKind={rowKind}
          actorHue={props.actorHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          {...(liveText === undefined ? {} : { liveText })}
          editControl={editControlOf(props)}
          thinkingRow={
            rowKind.kind === "thinking" ? (
              <BoundThinkingRow runId={attributedRunId} liveText={liveText} />
            ) : undefined
          }
        />
      );
  }
}

/** The edit control the footer renderer draws, or nothing. */
function editControlOf(props: TranscriptRowProps): React.ReactNode {
  return findTranscriptRowFooterRenderer()?.({ row: props.row, isSuperseded: props.isSuperseded });
}
