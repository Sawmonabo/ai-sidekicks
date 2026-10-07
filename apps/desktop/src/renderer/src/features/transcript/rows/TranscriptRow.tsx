// The transcript's row renderer: one row through the card its kind names. It holds no state: a
// disclosure press writes density to the list's retained row state, because the virtualizer
// unmounts rows scrolled out of range. A `TranscriptEventRow` carries no body, so machine rows
// render the empty state `MessageContent` and `ToolOutput` draw for an unread body. A type the kind
// table does not name has no card, and `drawsTranscriptRowBody` says so before the feed lists it.

import { useCallback, useState } from "react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { useRetainedRowState } from "../viewport/hooks/useRetainedRowState.js";
import { useRowReveal } from "../reveal/hooks/useRowReveal.js";
import { type TranscriptRowDensity, type TranscriptRowProps } from "./renderer.js";
import { findTranscriptRowFooterRenderer } from "./footer-renderer.js";
import { FootnoteRegistry } from "./markdown/footnotes/registry.js";
import { MessageRow } from "./MessageRow.js";
import { classifyTranscriptRow } from "./kind.js";
import { ThinkingRowWithRead } from "./thinking/ThinkingRowWithRead.js";
import { reasoningRunIdOf } from "./thinking/reasoning-reading.js";
import { ToolRow } from "./ToolRow.js";

/**
 * One row, through the card its kind names. The classifier decides once and this switch spends
 * the answer, so the glyph, label and layout match what the cards read anywhere else. Throws for
 * a row with no card, which `drawsTranscriptRowBody` keeps out of the list.
 */
export function TranscriptRow(props: TranscriptRowProps): React.JSX.Element {
  const [footnotes] = useState(() => new FootnoteRegistry());
  const retainedRowState = useRetainedRowState();
  const rowId = props.row.id;
  const density: TranscriptRowDensity = props.density;
  // The toggle inverts the density the row was handed (the list's answer with the retained state
  // overlaid) and writes it to the list, not to local state, which would die when the virtualizer
  // unmounts the row. `innerScrollTopPx` is zero because this row keeps no inner scroll of its own.
  const toggleDensity = useCallback(() => {
    retainedRowState.setRetainedState(rowId, {
      density: density === "expanded" ? "collapsed" : "expanded",
      innerScrollTopPx: 0,
    });
  }, [density, rowId, retainedRowState]);

  const rowKind = classifyTranscriptRow(props.row);
  // The reasoning read is armed in the component that renders it, not here: an ordinary row would
  // build a reading for a control it does not draw, and on a mounted window that per-row
  // machinery was the frame a streaming lane spent and the heap a long-open window kept. Only the
  // pure read the branch turns on stays here.
  const attributedRunId = reasoningRunIdOf(props.row);
  // The live-text lane is the row, matching `MessageContent`'s `liveText`: keying on the run
  // would give two machine rows of one turn one body. It arrives through the per-row reveal
  // channel, not the renderer's props, as the lane's handle rather than its text, and is
  // `undefined` for every row of a settled log.
  const liveText = useRowReveal(rowId);

  if (rowKind === undefined) {
    // The feed leaves such a row out of its list, so reaching here is a broken composition, not a
    // row to draw as a blank band.
    throw new Error(`TranscriptRow has no card for a ${props.row.type} row.`);
  }
  switch (rowKind.kind) {
    case "tool-call":
      return (
        <ToolRow
          row={props.row}
          agentHue={props.agentHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          {...(liveText === undefined ? {} : { liveText })}
          onDensityToggle={toggleDensity}
        />
      );
    case "user-message":
    case "agent-message":
    case "thinking":
      return (
        <MessageRow
          row={props.row}
          rowKind={rowKind}
          agentHue={props.agentHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          {...(liveText === undefined ? {} : { liveText })}
          replyRowIds={props.replyRowIds}
          editControl={editControlOf(props)}
          thinkingRow={
            rowKind.kind === "thinking" ? (
              <ThinkingRowWithRead runId={attributedRunId} liveText={liveText} />
            ) : undefined
          }
        />
      );
  }
}

/**
 * Whether `TranscriptRow` draws a card for this row: only a row the kind table names has one. The
 * same classification the row's own switch spends, so the two cannot disagree.
 */
export function drawsTranscriptRowBody(row: TranscriptEventRow): boolean {
  return classifyTranscriptRow(row) !== undefined;
}

/** The edit control the footer renderer draws, or nothing. */
function editControlOf(props: TranscriptRowProps): React.ReactNode {
  return findTranscriptRowFooterRenderer()?.({ row: props.row, isSuperseded: props.isSuperseded });
}
