// Which chapters are open.
//
// Its own file beside `run-groups.test.ts` because the subject is a different one:
// that suite pins how rows partition into chapters, and these cases pin which of
// the resulting chapters renders its body. Both fold the same window, through
// `run-groups.test-support.ts`.
//
// Every rule here fails SILENTLY. A collapsed live chapter still renders a header, so
// each clean assertion is paired with the control that fails when the rule is removed.

import { describe, expect, it } from "vitest";

import { RunGroupFoldState } from "./run-group-fold-state.js";
import { findRunGroup, mixedWindow } from "./run-groups.test-support.js";
import { groupRowsByRun } from "./run-groups.js";

describe("chapters — collapse state never folds the live chapter", () => {
  const live = findRunGroup(groupRowsByRun(mixedWindow()).chapters, "run-a");
  const terminal = findRunGroup(groupRowsByRun(mixedWindow()).chapters, "run-b");

  it("reports the live chapter open and the terminal chapter folded, before anything is clicked", () => {
    const state = new RunGroupFoldState();
    expect(state.isOpen(live)).toBe(true);
    expect(state.isOpen(terminal)).toBe(false);
  });

  it("negative control: closing the live chapter changes nothing", () => {
    // Without the live arm answering first, `close` would remove it from the open
    // set and the next `isOpen` would report a live chapter folded.
    const state = new RunGroupFoldState();
    expect(state.close(live)).toBe(false);
    expect(state.isOpen(live)).toBe(true);
  });

  it("opens a folded chapter and keeps it open until it is closed", () => {
    const state = new RunGroupFoldState();
    state.open(terminal);
    expect(state.isOpen(terminal)).toBe(true);
    expect(state.close(terminal)).toBe(true);
    expect(state.isOpen(terminal)).toBe(false);
  });

  it("collapses every terminal chapter and reports how many it folded", () => {
    const state = new RunGroupFoldState();
    state.open(terminal);
    expect(state.collapseAllTerminal([live, terminal])).toBe(1);
    expect(state.openedTerminalRunIds.size).toBe(0);
  });
});
