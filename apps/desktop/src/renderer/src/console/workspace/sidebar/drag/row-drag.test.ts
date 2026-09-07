// What a dropped sidebar row does, and what a payload that is not ours does not.
//
// The library's element adapter cannot be driven in this tier — jsdom implements
// neither `DragEvent` nor `DataTransfer` — so what is asserted here is the seam either
// side of it: the payload reader and the settle. That is the same split
// `workspace/deck/pane-drag.test.ts` makes for the deck's drop.

import { type ConsolePaneAddress } from "../../../seats/index.js";
import {
  SIDEBAR_ROW_DRAG_KEY,
  commitSidebarRowDrop,
  sidebarRowTargetFromDragData,
} from "./row-drag.js";

const RUNS_PANE: ConsolePaneAddress = { kind: "runs" };

const ROW_TARGET = { nodeId: "run-1", label: "Draft the migration", opens: RUNS_PANE };

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

describe("settling a sidebar row drop", () => {
  it("opens what the row names, through the column's own opener", () => {
    // Through the opener the column was handed — so a sidebar in an auxiliary window
    // opens into THAT window's deck — and never through a registry reached by import.
    const opened: ConsolePaneAddress[] = [];
    const announced: string[] = [];

    commitSidebarRowDrop(
      ROW_TARGET,
      (address) => opened.push(address),
      (message) => announced.push(message),
    );

    expect(opened).toStrictEqual([RUNS_PANE]);
    expect(announced).toStrictEqual(["Opened Draft the migration in the deck."]);
  });

  it("negative control: a drag released over nothing opens nothing and says nothing", () => {
    // Without this the case above would pass over a settle that opened on every drop,
    // including the ones a person abandoned.
    const opened: ConsolePaneAddress[] = [];
    const announced: string[] = [];

    commitSidebarRowDrop(
      undefined,
      (address) => opened.push(address),
      (message) => announced.push(message),
    );

    expect(opened).toStrictEqual([]);
    expect(announced).toStrictEqual([]);
  });
});
