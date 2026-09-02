// The fixture shell for the timeline row seat — the stand-in, and its own death notice.
//
// THE ABSORB-BY-IMPORT RULE, which this file is one half of.
// `seats/timeline-row-slot.ts` states it: the seat is filled TWICE, in two changes,
// and the second DELETES the first. This is the first — a row that renders the ledger's cards
// against fixture scenarios so the timeline surface is real before Plan-013's rows
// exist. The `timeline/` subtree, which Plan-013 owns, replaces this registration in its
// own pull request AND DELETES THIS FILE IN THE SAME DIFF.
//
// THE DELETION IS NOT OPTIONAL AND NOT COSMETIC. The seat is owner-scoped, so a second
// owner is refused by name rather than winning by import order: a change that registered
// Plan-013's row without deleting this shell would not render both rows, it would stop
// the timeline from rendering at all, at import time. Deleting the shell is what makes
// the replacement work.
//
// NOTHING HERE RENDERS A SPEC-013 ENTRY TYPE. The shell is generic over
// `TimelineRowSlotProps` — it reads `kind`, `type`, `summary`, `timestamp`, and the
// three list decisions the seat carries, and nothing else. A shell that modelled the
// timeline's own entry vocabulary would be authoring the body it exists to stand in for,
// and Plan-013 would then have two.
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
// renders the named absence `MachineBody` gives an unread body, and live text is absent
// for the same honest reason: it is published by the reveal engine and handed down by
// the viewport, which is not this seat.

import { useCallback, useState } from "react";

import { useLedgerRowLease } from "../frame/index.js";
import { LedgerRow, Nothing } from "../../primitives/index.js";
import {
  registerTimelineRowRenderer,
  type TimelineRowDensity,
  type TimelineRowSlotProps,
} from "../../seats/index.js";
import { classifyCardFamily } from "./card-family.js";
import { FootnoteRegistry } from "./markdown/index.js";
import { EDIT_AFFORDANCE_SLOT, MessageCard } from "./MessageCard.js";
import { ToolCard } from "./ToolCard.js";

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

  switch (family.family) {
    case "tool-activity":
      return (
        <ToolCard
          row={props.row}
          participantHue={props.participantHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          onDensityToggle={toggleDensity}
        />
      );
    case "participant-message":
    case "assistant-message":
    case "assistant-reasoning":
      return (
        <MessageCard
          row={props.row}
          participantHue={props.participantHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          editAffordance={{ contract: EDIT_AFFORDANCE_SLOT, body: undefined }}
        />
      );
    case "receipt":
      return <ReceiptRow {...props} />;
  }
}

/**
 * A row that carries no body: one line, stating what happened.
 *
 * The overwhelming majority of the event taxonomy lands here, which is why the line is
 * the row's own wire summary and nothing else. A summary that is empty says so by name
 * rather than rendering as a blank line a reader would scroll past.
 */
function ReceiptRow(props: TimelineRowSlotProps): React.JSX.Element {
  return (
    <LedgerRow
      participantHueStep={props.participantHue?.step ?? -1}
      {...(props.participantHue === undefined
        ? {}
        : { ringTreatment: props.participantHue.ringTreatment })}
      occurredAtIso={props.row.timestamp}
      actorLabel={props.row.actor ?? "Session"}
      kindLabel={props.row.type}
      isSuperseded={props.isSuperseded}
    >
      {props.row.summary === "" ? (
        <Nothing kind="empty" placement="inline" title="This event carries no summary." />
      ) : (
        <p className="meridian-receipt-row">{props.row.summary}</p>
      )}
    </LedgerRow>
  );
}

/**
 * Claim the timeline row seat for the shell.
 *
 * A function rather than a module-scope call: a module whose import registers a seat
 * cannot be composed twice by a test, and the seat's own owner scoping would then refuse
 * the second composition rather than replace it. The window that mounts the ledger calls
 * this; the change that lands Plan-013's row deletes both the call and this file.
 */
export function registerFixtureShellRows(): void {
  registerTimelineRowRenderer(FIXTURE_SHELL_OWNER, FixtureShellRow);
}
