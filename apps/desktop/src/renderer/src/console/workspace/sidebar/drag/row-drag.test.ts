// What a dropped sidebar row does, and what a payload that is not ours does not.
//
// The library's element adapter cannot be driven in this tier — jsdom implements
// neither `DragEvent` nor `DataTransfer` — so what is asserted here is the seam either
// side of it: the payload reader and the settle. That is the same split
// `workspace/deck/pane-drag.test.ts` makes for the deck's drop.

import { type ConsolePaneAddress } from "../../../seats/index.js";
import {
  SIDEBAR_ROW_DECK_DROP_KEY,
  SIDEBAR_ROW_DRAG_KEY,
  commitSidebarRowDrop,
  isSidebarRowDeckDropTarget,
  sidebarRowTargetFromDragData,
} from "./row-drag.js";

const RUNS_PANE: ConsolePaneAddress = { kind: "runs" };

const ROW_TARGET = { nodeId: "run-1", label: "Draft the migration", opens: RUNS_PANE };

/** What one settled drop did, in the two vocabularies a person meets it in. */
interface RecordedDrop {
  readonly opened: ConsolePaneAddress[];
  readonly announced: { readonly message: string; readonly politeness: string | undefined }[];
}

/**
 * Settle one drop against recorders rather than against the deck.
 *
 * The element adapter cannot be driven in this tier, so the drop location arrives as
 * the boolean the monitor derives from it — which is the same argument the monitor
 * passes and therefore the same rule under test.
 */
function settleDrop(target: typeof ROW_TARGET | undefined, droppedOnDeck: boolean): RecordedDrop {
  const opened: ConsolePaneAddress[] = [];
  const announced: RecordedDrop["announced"] = [];
  commitSidebarRowDrop(
    target,
    droppedOnDeck,
    (address) => opened.push(address),
    (message, politeness) => announced.push({ message, politeness }),
  );
  return { opened, announced };
}

describe("reading a sidebar row off a drag payload", () => {
  it("reads back what the source put on it", () => {
    expect(sidebarRowTargetFromDragData({ [SIDEBAR_ROW_DRAG_KEY]: ROW_TARGET })).toStrictEqual(
      ROW_TARGET,
    );
  });

  it("declines a payload that is not a sidebar row's", () => {
    // The element adapter's monitor sees every element drag on the page, the deck's
    // pane header included. A payload this monitor does not recognise is one it
    // declines to act on rather than one it misreads.
    expect(sidebarRowTargetFromDragData({ "deck.paneId": "pane-1" })).toBeUndefined();
    expect(sidebarRowTargetFromDragData({})).toBeUndefined();
  });

  it("declines a row payload missing the address it would open", () => {
    // A row that opens nothing is not a drag target, and a drop that opened a pane
    // from a payload with no address would be opening whatever the deck defaults to.
    expect(
      sidebarRowTargetFromDragData({
        [SIDEBAR_ROW_DRAG_KEY]: { nodeId: "run-1", label: "Draft the migration" },
      }),
    ).toBeUndefined();
  });
});

describe("recognising the deck as a place a row may land", () => {
  it("reads back the deck's own target", () => {
    expect(isSidebarRowDeckDropTarget({ [SIDEBAR_ROW_DECK_DROP_KEY]: true })).toBe(true);
  });

  it("declines a target that is not the deck's", () => {
    // The drop targets a gesture settles over include every one the pointer was inside,
    // so a target this console did not register — or the deck's own per-pane targets,
    // which carry the pane key — must not be read as the board.
    expect(isSidebarRowDeckDropTarget({ "deck.paneId": "pane-1" })).toBe(false);
    expect(isSidebarRowDeckDropTarget({})).toBe(false);
  });
});

describe("settling a sidebar row drop", () => {
  it("opens what the row names, through the column's own opener", () => {
    // Through the opener the column was handed — so a sidebar in an auxiliary window
    // opens into THAT window's deck — and never through a registry reached by import.
    const settled = settleDrop(ROW_TARGET, true);

    expect(settled.opened).toStrictEqual([RUNS_PANE]);
    expect(settled.announced).toStrictEqual([
      { message: "Opened Draft the migration in the deck.", politeness: "polite" },
    ]);
  });

  it("opens nothing when the row was released anywhere but the deck", () => {
    // The defect this closes: `canMonitor` had already established that the SOURCE was
    // a row, and the settle read that same source again without asking where the
    // gesture ended. A monitor hears a drop over the sidebar, over the window chrome,
    // and one abandoned outright — so releasing a row back where it came from opened
    // its pane and announced success.
    const settled = settleDrop(ROW_TARGET, false);

    expect(settled.opened).toStrictEqual([]);
    // Said, and said in the assertive lane, on `deck/pane-drag.ts`'s own rule for the
    // same outcome: a person who cannot see the deck has no other way to learn that a
    // gesture they completed changed nothing.
    expect(settled.announced).toStrictEqual([
      { message: "Draft the migration was not opened.", politeness: "assertive" },
    ]);
  });

  it("negative control: a drag released over nothing opens nothing and says nothing", () => {
    // Without this the case above would pass over a settle that opened on every drop,
    // including the ones a person abandoned.
    const settled = settleDrop(undefined, true);

    expect(settled.opened).toStrictEqual([]);
    expect(settled.announced).toStrictEqual([]);
  });
});
