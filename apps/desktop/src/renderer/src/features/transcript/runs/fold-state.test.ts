// Which run groups are open, apart from `groups.test.ts`, which pins how rows partition.
// Both fold the same window through `groups.test-support.ts`. Each rule fails silently (a
// collapsed live run group still renders a header), so each clean assertion has a control.

import { describe, expect, it } from "vitest";

import { RunGroupFoldState } from "./fold-state.js";
import { findRunGroup, mixedWindow } from "./groups.test-support.js";
import { groupRowsByRun } from "./groups.js";

describe("run groups — collapse state never folds the live run group", () => {
  const live = findRunGroup(groupRowsByRun(mixedWindow()), "run-a");
  const terminal = findRunGroup(groupRowsByRun(mixedWindow()), "run-b");

  it(
    "reports the live run group open and the terminal run group " +
      "folded, before anything is clicked",
    () => {
      const state = new RunGroupFoldState();
      expect(state.isOpen(live)).toBe(true);
      expect(state.isOpen(terminal)).toBe(false);
    },
  );

  it("closing the live run group changes nothing", () => {
    // Without the live arm answering first, `close` would remove it from the open set and
    // `isOpen` would report a live run group folded.
    const state = new RunGroupFoldState();
    expect(state.close(live)).toBe(false);
    expect(state.isOpen(live)).toBe(true);
  });

  it("collapses every terminal run group and reports how many it folded", () => {
    const state = new RunGroupFoldState();
    state.open(terminal);
    expect(state.collapseAllTerminal([live, terminal])).toBe(1);
    expect(state.openedTerminalRunIds.size).toBe(0);
  });
});
