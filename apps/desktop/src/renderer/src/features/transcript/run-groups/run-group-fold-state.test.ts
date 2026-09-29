// Which chapters are open.
//
// Its own file beside `chapters.test.ts` because the subject is a different one:
// that suite pins how rows partition into chapters, and these cases pin which of
// the resulting chapters renders its body. Both fold the same window, through
// `chapters.test-support.ts`.
//
// Every rule here fails SILENTLY. A collapsed live chapter still renders a header, so
// each clean assertion is paired with the control that fails when the rule is removed.

import { describe, expect, it } from "vitest";

import { ChapterCollapseState } from "./run-group-fold-state.js";
import { chapterFor, mixedWindow } from "./run-groups.test-support.js";
import { foldChapters } from "./run-groups.js";

describe("chapters — collapse state never folds the live chapter", () => {
  const live = chapterFor(foldChapters(mixedWindow()).chapters, "run-a");
  const terminal = chapterFor(foldChapters(mixedWindow()).chapters, "run-b");

  it("reports the live chapter open and the terminal chapter folded, before anything is clicked", () => {
    const state = new ChapterCollapseState();
    expect(state.isOpen(live)).toBe(true);
    expect(state.isOpen(terminal)).toBe(false);
  });

  it("negative control: closing the live chapter changes nothing", () => {
    // Without the live arm answering first, `close` would remove it from the open
    // set and the next `isOpen` would report a live chapter folded.
    const state = new ChapterCollapseState();
    expect(state.close(live)).toBe(false);
    expect(state.isOpen(live)).toBe(true);
  });

  it("opens a folded chapter and keeps it open until it is closed", () => {
    const state = new ChapterCollapseState();
    state.open(terminal);
    expect(state.isOpen(terminal)).toBe(true);
    expect(state.close(terminal)).toBe(true);
    expect(state.isOpen(terminal)).toBe(false);
  });

  it("collapses every terminal chapter and reports how many it folded", () => {
    const state = new ChapterCollapseState();
    state.open(terminal);
    expect(state.collapseAllTerminal([live, terminal])).toBe(1);
    expect(state.openedTerminalRunIds.size).toBe(0);
  });
});
