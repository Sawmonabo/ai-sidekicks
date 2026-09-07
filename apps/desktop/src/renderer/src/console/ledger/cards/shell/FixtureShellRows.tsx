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
// renders the named absence `MachineBody` gives an unread body.
//
// LIVE TEXT IS A DIFFERENT CASE AND IS NO LONGER ABSENT BY CONSTRUCTION. It is published
// by the reveal engine, which the feed now owns, and it reaches a row through the frame's
// own per-row channel rather than through the seat — `ledger/frame/reveal/RowRevealProvider.tsx`
// states why the seat is the wrong home for it. The row asks for its own lane and gets
// `undefined` while nothing is streaming into it, which is every row of a settled log.

import { useCallback, useState } from "react";

import { useConsoleClock } from "../../../bridge/index.js";
import { parseInstant } from "../../../core/index.js";
import { useDeadlineWake } from "../../../store/index.js";
import { useLedgerRowLease, useLedgerRowReveal } from "../../frame/index.js";
import {
  registerTimelineRowRenderer,
  type TimelineRowDensity,
  type TimelineRowSlotProps,
} from "../../../seats/index.js";
import {
  INPUT_ASK_SLOT,
  InputAskCard,
  REASONING_SURFACE_SLOT,
  ReasoningSurface,
  readDriverAsk,
  reasoningRunIdOf,
} from "../bodies/index.js";
import { classifyCardFamily } from "../card-family.js";
import { FootnoteRegistry } from "../markdown/index.js";
import { EDIT_AFFORDANCE_SLOT, MessageCard } from "../MessageCard.js";
import { ReceiptRow } from "../ReceiptRow.js";
import { useDriverAskAnswer, useReasoningSurfaceRead } from "./shell-row-reads.js";
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
  // BOTH READS ARE ARMED FOR EVERY ROW AND NEITHER CALLS FOR MOST OF THEM. Hooks run
  // unconditionally by the rules of hooks, so the run identity and the ask reading are
  // resolved on every row; the reasoning read issues nothing until a reader presses
  // the control, and the answer dispatcher refuses an empty ask id, so a row that is
  // neither a reasoning row nor an ask row costs two `useCallback`s and no call.
  const attributedRunId = reasoningRunIdOf(props.row);
  const reasoningRead = useReasoningSurfaceRead(attributedRunId);
  const ask = readDriverAsk(props.row);
  const answerAsk = useDriverAskAnswer(attributedRunId, ask?.askId ?? "");
  // THE COUNTDOWN WAKES ONCE, AT ITS DEADLINE, AND NEVER POLLS. The console's one
  // deadline wake arms a single timeout for the soonest instant still ahead; a row
  // with no ask — which is nearly every row — hands it an empty list and it arms
  // nothing at all, so the ledger's steady state holds no timer per row.
  const clock = useConsoleClock();
  const askDeadlines = askDeadlineMillisecondsOf(ask?.expiresAt);
  const nowEpochMilliseconds = useDeadlineWake(clock, askDeadlines);
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
    return (
      <InputAskCard
        slot={{ contract: INPUT_ASK_SLOT, body: undefined }}
        ask={ask}
        nowEpochMilliseconds={nowEpochMilliseconds}
        onAnswer={answerAsk}
      />
    );
  }

  switch (family.family) {
    case "tool-activity":
      return (
        <ToolCard
          row={props.row}
          participantHue={props.participantHue}
          isSuperseded={props.isSuperseded}
          density={density}
          footnotes={footnotes}
          {...(liveText === undefined ? {} : { liveText })}
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
          {...(liveText === undefined ? {} : { liveText })}
          editAffordance={{ contract: EDIT_AFFORDANCE_SLOT, body: undefined }}
          reasoningSurface={
            family.family === "assistant-reasoning" ? (
              <ReasoningSurface
                slot={{ contract: REASONING_SURFACE_SLOT, body: undefined }}
                runId={attributedRunId}
                liveText={liveText}
                reading={reasoningRead.reading}
                onExpand={reasoningRead.expand}
              />
            ) : undefined
          }
        />
      );
    case "receipt":
      return <ReceiptRow {...props} />;
  }
}

/**
 * One ask's deadline as a wake-up list, or none.
 *
 * Read through the console's own instant reader, which is the reader the card uses
 * for the same stamp — so the row that arms a wake-up and the card that counts one
 * down can never disagree about whether a stamp is readable. A stamp neither can
 * read arms nothing rather than firing a timer forever, and the card renders it as
 * the named absence it is.
 */
function askDeadlineMillisecondsOf(expiresAt: string | undefined): readonly number[] {
  if (expiresAt === undefined) {
    return NO_DEADLINES;
  }
  const reading = parseInstant(expiresAt);
  return reading.kind === "instant" ? [reading.epochMilliseconds] : NO_DEADLINES;
}

/** No deadline at all. One frozen value, so the ordinary row allocates none. */
const NO_DEADLINES: readonly number[] = Object.freeze([]);

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
