// The transcript row renderer registered for the timeline row seat: one row, through the
// row component its kind names.
//
// NOTHING HERE RENDERS A TIMELINE ENTRY TYPE. The renderer is generic over
// `TranscriptRowProps` — it reads `kind`, `type`, `summary`, `timestamp`, and the
// three list decisions the seat carries, and nothing else. Modelling the timeline's own
// entry vocabulary here would author a second body beside the real one.
//
// IT HOLDS NO STATE OF ITS OWN. A disclosure press writes the row's density to the list's
// retained row state through `useRetainedRowState`, and the density it renders is
// whatever it was handed. That is the only way the choice survives: the virtualizer mounts
// the visible range and nothing else, so anything a row remembers privately is discarded
// the moment a reader scrolls past it.
//
// WHAT IT CANNOT SUPPLY, stated rather than papered over. A machine-authored body lives
// in the daemon's own encrypted column and reaches a reader through a hydrated read
// projection; a `TimelineRow` carries neither the body nor a reference to one. So every
// machine row here renders the named absence `MessageContent` and `ToolOutput` give an unread body.
//
// LIVE TEXT IS A DIFFERENT CASE. It is published by the reveal engine, which the feed
// owns, and it reaches a row through the frame's own per-row channel rather than through
// the seat — `reveal/components/RowRevealProvider.tsx` states why the seat is the wrong
// home for it. The row asks for its own lane and gets `undefined` while nothing is
// streaming into it, which is every row of a settled log.
//
// A ROW THE FAMILY TABLE CALLS A RECEIPT DRAWS NOTHING. An event outside the transcript's
// fold list is not drawn, and the classifier's `receipt` answer is that case.

import { useCallback, useState } from "react";

import { useRetainedRowState } from "../viewport/hooks/useRetainedRowState.js";
import { useRowReveal } from "../reveal/hooks/useRowReveal.js";
import {
  type TranscriptRowDensity,
  type TranscriptRowProps,
} from "@renderer/console/seats/index.js";
import { findTranscriptRowFooterRenderer } from "../transcript-row-footer-renderer.js";
import { FootnoteRegistry } from "./markdown/footnotes/footnote-registry.js";
import { MessageRow } from "./MessageRow.js";
import { classifyTranscriptRow } from "./row-kind.js";
import { BoundThinkingRow } from "./thinking/BoundThinkingRow.js";
import { reasoningRunIdOf } from "./thinking/reasoning-reading.js";
import { ToolRow } from "./ToolRow.js";

/**
 * One row, through the card its family names.
 *
 * The classifier decides once and this switch spends the answer — the same table the
 * cards themselves read, so the glyph, the label, and the layout a row gets here are the
 * ones it gets anywhere.
 */
export function TranscriptRow(props: TranscriptRowProps): React.JSX.Element | null {
  const [footnotes] = useState(() => new FootnoteRegistry());
  const rowLease = useRetainedRowState();
  const rowId = props.row.id;
  const density: TranscriptRowDensity = props.density;
  // THE TOGGLE INVERTS WHAT IS ON SCREEN, which is the density the row was HANDED —
  // the list's answer with the lease already overlaid on it. So the press reverses
  // what a reader can see, and it writes the reversal to the list rather than to this
  // component: a `useState` here died with the row the moment the virtualizer scrolled
  // it out of the mounted range, and the choice came back as whatever the list said.
  // `innerScrollTopPx` is zero because this shell keeps no inner scroll of its own;
  // a body that does parks its offset in the same lease.
  const toggleDensity = useCallback(() => {
    rowLease.setLease(rowId, {
      density: density === "expanded" ? "collapsed" : "expanded",
      innerScrollTopPx: 0,
    });
  }, [density, rowId, rowLease]);

  const family = classifyTranscriptRow(props.row);
  // THE REASONING READ IS NOT ARMED HERE, AND THAT IS A COST RULE RATHER THAN A STYLE
  // ONE. It binds a COMPONENT, not a tree, so it lives in the component that renders it,
  // and the ordinary row builds no reading for a control it does not draw. Measured on a
  // mounted window, that per-row machinery was the frame a streaming lane spent and the
  // heap a console left open kept.
  //
  // WHAT STAYS HERE IS THE PURE READ the branch turns on: which run the row attributes.
  const attributedRunId = reasoningRunIdOf(props.row);
  // THE LANE IS THE ROW, which is what `MessageContent` already claims of the member it
  // fills: "text the reveal engine is publishing for THIS ROW right now". Keying on the
  // run instead would give two machine rows of one turn one body between them.
  const liveText = useRowReveal(rowId);

  if (family === undefined) {
    return null;
  }
  switch (family.kind) {
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
          rowKind={family}
          actorHue={props.actorHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          {...(liveText === undefined ? {} : { liveText })}
          editControl={editControlOf(props)}
          thinkingRow={
            family.kind === "thinking" ? (
              <BoundThinkingRow runId={attributedRunId} liveText={liveText} />
            ) : undefined
          }
        />
      );
  }
}

/** The edit control the seat's owner draws, or nothing; the message row shows it on a user's own. */
function editControlOf(props: TranscriptRowProps): React.ReactNode {
  return findTranscriptRowFooterRenderer()?.({ row: props.row, isSuperseded: props.isSuperseded });
}
