// The transcript's row renderer: one row through the card its kind names. It holds no state: a
// call's fold press and its output's `Show all` go to the feed's folds, because the virtualizer
// unmounts rows scrolled out of range, and every press that changes the row's height asks the feed
// to hold the row where it stands. A row read from history carries its body, which the
// cards draw; a streamed row and a large body carry none, and the cards draw the state
// `MessageContent` and `ToolOutput` give an unread body. A type the kind table does not name has no
// card, and `drawsTranscriptRowBody` says so before the feed lists it.

import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from "react";

import { useRowReveal } from "../reveal/hooks/useRowReveal.js";
import { useRowToggle } from "./hooks/useRowToggle.js";
import { type OutputOpening } from "./bodies/OutputHeightCut.js";
import { type TranscriptRowProps } from "./renderer.js";
import { findTranscriptRowFooterRenderer } from "./footer-renderer.js";
import { FootnoteRegistry } from "./markdown/footnotes/registry.js";
import { MessageRow } from "./MessageRow.js";
import { classifyTranscriptRow } from "./kind.js";
import { ThinkingRowWithRead } from "./thinking/ThinkingRowWithRead.js";
import { reasoningRunIdOf } from "./thinking/reasoning-reading.js";
import { ToolRow } from "./ToolRow.js";
import { WaitingRowControls, WaitingRowNotice } from "../queue/components/WaitingRowControls.js";
import { WaitingRowsContext } from "../queue/waiting-rows.js";
import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/**
 * One row, through the card its kind names. The classifier decides once and this switch spends
 * the answer, so the glyph and label match what the cards read anywhere else. Throws for a row
 * with no card, which `drawsTranscriptRowBody` keeps out of the list.
 */
export function TranscriptRow(props: TranscriptRowProps): React.JSX.Element {
  const [footnotes] = useState(() => new FootnoteRegistry());
  const { toggleCallFold, openOutput, holdRowInPlace } = useRowToggle();
  const rowId = props.row.id;
  // The fold goes to the feed, not to local state, which would die when the virtualizer unmounts
  // the row.
  const toggleFold = useCallback(() => {
    toggleCallFold(rowId);
  }, [rowId, toggleCallFold]);
  const isOutputOpened = props.isOutputOpened;
  const outputOpening = useMemo<OutputOpening>(
    () => ({
      isOpened: isOutputOpened,
      open: () => {
        openOutput(rowId);
      },
    }),
    [isOutputOpened, openOutput, rowId],
  );
  const holdRow = useCallback(() => {
    holdRowInPlace(rowId);
  }, [rowId, holdRowInPlace]);

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
  // A person's message the agent has not taken yet, from the press on. A row that does not wait
  // reads `undefined` however the waiting rows change, so it does not render for them.
  const waitingRowsChannel = useContext(WaitingRowsContext);
  const waitingRows = useSyncExternalStore(
    waitingRowsChannel?.subscribe ?? subscribeToNothing,
    () => waitingRowsChannel?.waitingRowsOf(rowId),
  );
  const waitingRow = waitingRows?.waitingRowByKey.get(rowId);

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
          density={props.density}
          footnotes={footnotes}
          {...(props.row.content === undefined ? {} : { content: props.row.content })}
          {...(liveText === undefined ? {} : { liveText })}
          holdRowInPlace={holdRow}
          onDensityToggle={toggleFold}
          outputOpening={outputOpening}
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
          density={props.density}
          footnotes={footnotes}
          {...(props.row.content === undefined ? {} : { content: props.row.content })}
          {...(liveText === undefined ? {} : { liveText })}
          holdRowInPlace={holdRow}
          replyRowIds={props.replyRowIds}
          editControl={editControlOf(props)}
          waiting={
            waitingRow === undefined || waitingRows === undefined
              ? undefined
              : {
                  notice: (
                    <WaitingRowNotice
                      rowKey={rowId}
                      waitingRow={waitingRow}
                      waitingRows={waitingRows}
                    />
                  ),
                  controls: (
                    <WaitingRowControls
                      rowKey={rowId}
                      waitingRow={waitingRow}
                      waitingRows={waitingRows}
                    />
                  ),
                  isEditing: waitingRows.editingRowKey === rowId,
                  isUndelivered: waitingRow.item?.state === "notDelivered",
                  cardRef: waitingRows.drag.itemRef(rowId),
                }
          }
          thinkingRow={
            rowKind.kind === "thinking" ? (
              <ThinkingRowWithRead
                runId={attributedRunId}
                liveText={liveText}
                storedText={
                  props.row.content?.status === "available" ? props.row.content.body : undefined
                }
                holdRowInPlace={holdRow}
              />
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
export function drawsTranscriptRowBody(row: ProjectedTranscriptRow): boolean {
  return classifyTranscriptRow(row) !== undefined;
}

/** Outside a feed no row waits, so there is nothing to watch. */
function subscribeToNothing(): () => void {
  return () => undefined;
}

/** The edit control the footer renderer draws, or nothing. */
function editControlOf(props: TranscriptRowProps): React.ReactNode {
  return findTranscriptRowFooterRenderer()?.({ row: props.row, isSuperseded: props.isSuperseded });
}
