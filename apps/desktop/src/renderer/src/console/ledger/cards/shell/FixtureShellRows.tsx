// The fixture shell for the timeline row seat — the stand-in, and its own death notice.
//
// THE ABSORB-BY-IMPORT RULE, which this file is one half of.
// `seats/slots/timeline-row-slot.ts` states it: the seat is filled TWICE, in two changes,
// and the second DELETES the first. This is the first — a row that renders the ledger's cards
// against fixture scenarios so the timeline surface is real before the real rows
// exist. The `timeline/` subtree replaces this registration in its own pull request AND
// DELETES THIS FILE IN THE SAME DIFF.
//
// THE DELETION IS NOT OPTIONAL AND NOT COSMETIC. The seat is owner-scoped, so a second
// owner is refused by name rather than winning by import order: a change that registered
// the real row without deleting this shell would not render both rows, it would stop
// the timeline from rendering at all, at import time. Deleting the shell is what makes
// the replacement work.
//
// NOTHING HERE RENDERS A TIMELINE ENTRY TYPE. The shell is generic over
// `TimelineRowSlotProps` — it reads `kind`, `type`, `summary`, `timestamp`, and the
// three list decisions the seat carries, and nothing else. A shell that modelled the
// timeline's own entry vocabulary would be authoring the body it exists to stand in
// for, and the tree would then have two.
//
// THE SHELL HOLDS NO STATE OF ITS OWN, which is what its own header claims and what
// it now is. A disclosure press writes the row's density to the list's lease table
// through `ledger/frame/`'s lease channel, and the density it renders is whatever it
// was handed. That is the only way the choice survives: the virtualizer mounts the
// visible range and nothing else, so anything a row remembers privately is discarded
// the moment a reader scrolls past it.
//
// WHAT THE SHELL CANNOT SUPPLY, stated rather than papered over. A machine-authored body
// lives in the daemon's own encrypted column and reaches a reader through a hydrated
// read projection; a `TimelineRow` carries neither the body nor a reference to one, and
// no bridge namespace serves that projection to this renderer. So every machine row here
// renders the named absence `MachineBody` gives an unread body.
//
// LIVE TEXT IS A DIFFERENT CASE AND IS NO LONGER ABSENT BY CONSTRUCTION. It is published
// by the reveal engine, which the feed now owns, and it reaches a row through the frame's
// own per-row channel rather than through the seat — `ledger/frame/reveal/RowRevealProvider.tsx`
// states why the seat is the wrong home for it. The row asks for its own lane and gets
// `undefined` while nothing is streaming into it, which is every row of a settled log.

import { useCallback, useState } from "react";

import { useLedgerRowLease, useLedgerRowReveal } from "../../frame/index.js";
import {
  registerTimelineRowRenderer,
  type TimelineRowDensity,
  type TimelineRowSlotProps,
} from "../../../seats/index.js";
import { readDriverAsk, reasoningRunIdOf } from "../bodies/index.js";
import { classifyCardFamily } from "../card-family.js";
import { FixtureShellAskRow } from "./FixtureShellAskRow.js";
import { FixtureShellReasoningSurface } from "./FixtureShellReasoningSurface.js";
import { FootnoteRegistry } from "../markdown/index.js";
import { EDIT_AFFORDANCE_SLOT, MessageCard } from "../MessageCard.js";
import { ReceiptRow } from "../ReceiptRow.js";
import { TOOL_SUB_FAMILY_SLOT } from "../tool-families/index.js";
import { ToolCard } from "../ToolCard.js";

/** The owner this shell claims the seat under. */
export const FIXTURE_SHELL_OWNER = "ledger fixture shell";

/**
 * One row, through the card its family names.
 *
 * The classifier decides once and this switch spends the answer — the same table the
 * cards themselves read, so the glyph, the label, and the layout a row gets here are the
 * ones it gets anywhere.
 */
export function FixtureShellRow(props: TimelineRowSlotProps): React.JSX.Element {
  const [footnotes] = useState(() => new FootnoteRegistry());
  const rowLease = useLedgerRowLease();
  const rowId = props.row.id;
  const density: TimelineRowDensity = props.density;
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

  const family = classifyCardFamily(props.row);
  // NEITHER READ IS ARMED HERE, AND THAT IS A COST RULE RATHER THAN A STYLE ONE. Both
  // used to be: the ask answer, the clock, the deadline wake, and the reasoning read
  // were called in this body under a comment saying the rules of hooks left no choice.
  // They bind a COMPONENT, not a tree — so each read now lives in the component that
  // renders it, and the ordinary row builds neither a subject-scoped holder for a
  // countdown it does not have nor a reading for a control it does not draw. Measured
  // on a mounted window, that per-row machinery was the frame a streaming lane spent
  // and the heap a console left open kept.
  //
  // WHAT STAYS HERE IS THE TWO PURE READS the branch itself turns on: which run the
  // row attributes and whether it carries an ask. Both are functions of the row.
  const attributedRunId = reasoningRunIdOf(props.row);
  const ask = readDriverAsk(props.row);
  // THE LANE IS THE ROW, which is what `MachineBody` already claims of the member it
  // fills: "text the reveal engine is publishing for THIS ROW right now". Keying on the
  // run instead would give two machine rows of one turn one body between them.
  const liveText = useLedgerRowReveal(rowId);

  // AHEAD OF THE FAMILY SWITCH, because an ask is not a card FAMILY. The classifier
  // reads the row's registered event type and the four `driver_ask.*` types carry no
  // machine-authored body, so they classify as receipts — which is the right answer
  // for the family table and the wrong surface for a run that is blocked on a
  // question. The ask reading is what distinguishes them, and it is a positive read
  // of the ask's own members rather than a sixth family nothing else would use.
  if (ask !== undefined) {
    // No second attribution beside the reading: the ask carries the run it was read
    // off, which is the same row `attributedRunId` reads, and handing the row both
    // would be two answers to which run an answer is delivered for.
    return <FixtureShellAskRow ask={ask} />;
  }

  switch (family.family) {
    case "tool-activity":
      return (
        <ToolCard
          row={props.row}
          actorHue={props.actorHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          {...(liveText === undefined ? {} : { liveText })}
          onDensityToggle={toggleDensity}
          subFamily={{ contract: TOOL_SUB_FAMILY_SLOT, body: undefined }}
        />
      );
    case "user-message":
    case "assistant-message":
    case "assistant-reasoning":
      return (
        <MessageCard
          row={props.row}
          actorHue={props.actorHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          {...(liveText === undefined ? {} : { liveText })}
          editAffordance={{ contract: EDIT_AFFORDANCE_SLOT, body: undefined }}
          reasoningSurface={
            family.family === "assistant-reasoning" ? (
              <FixtureShellReasoningSurface runId={attributedRunId} liveText={liveText} />
            ) : undefined
          }
        />
      );
    case "receipt":
      return <ReceiptRow {...props} />;
  }
}

/**
 * Claim the timeline row seat for the shell.
 *
 * A function rather than a module-scope call: a module whose import registers a seat
 * cannot be composed twice by a test, and the seat's own owner scoping would then refuse
 * the second composition rather than replace it. The window that mounts the ledger calls
 * this; the change that lands the real row deletes both the call and this file.
 */
export function registerFixtureShellRows(): void {
  registerTimelineRowRenderer(FIXTURE_SHELL_OWNER, FixtureShellRow);
}
