// Which chapters are open, and the four conditions an auto-collapse is conjunctive on.
//
// Its own file beside `chapters.test.ts` because the subject is a different one:
// that suite pins how rows partition into chapters, and these cases pin which of
// the resulting chapters renders its body. Both fold the same window, through
// `chapters.test-support.ts`.
//
// Every rule here fails SILENTLY. A collapsed live chapter still renders a header,
// and an auto-collapse that had quietly become a disjunction still folds something —
// so each clean assertion is paired with the control that fails when the rule is
// removed.

import { describe, expect, it } from "vitest";

import { ChapterCollapseState, type ChapterAutoCollapseObservation } from "./chapter-collapse.js";
import { chapterFor, mixedWindow } from "./chapters.test-support.js";
import { foldChapters } from "./chapters.js";

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

describe("chapters — auto-collapse is conjunctive on four conditions", () => {
  const terminal = chapterFor(foldChapters(mixedWindow()).chapters, "run-b");
  const live = chapterFor(foldChapters(mixedWindow()).chapters, "run-a");

  function openedState(): ChapterCollapseState {
    const state = new ChapterCollapseState();
    state.open(terminal);
    return state;
  }

  it("folds a terminal chapter that is off screen, freshly measured, and unengaged", () => {
    const state = openedState();
    expect(
      state.autoCollapse(terminal, {
        isOffScreen: true,
        hasFreshGeometrySample: true,
        isEngaged: false,
      }),
    ).toBe(true);
  });

  // Three negative controls, one per conjunct. Each drops exactly one condition
  // from the folding case above, so a rule that had quietly become a disjunction
  // fails here rather than folding a chapter somebody is reading.
  function refuses(observation: ChapterAutoCollapseObservation): void {
    const state = openedState();
    expect(state.autoCollapse(terminal, observation)).toBe(false);
    expect(state.isOpen(terminal)).toBe(true);
  }

  it("negative control: refuses to fold a chapter that is on screen", () => {
    refuses({ isOffScreen: false, hasFreshGeometrySample: true, isEngaged: false });
  });

  it("negative control: refuses to fold on geometry measured before the pane was hidden", () => {
    refuses({ isOffScreen: true, hasFreshGeometrySample: false, isEngaged: false });
  });

  it("negative control: refuses to fold a chapter that is engaged", () => {
    refuses({ isOffScreen: true, hasFreshGeometrySample: true, isEngaged: true });
  });

  it("never auto-collapses the live chapter, whatever the geometry says", () => {
    const state = openedState();
    expect(
      state.autoCollapse(live, {
        isOffScreen: true,
        hasFreshGeometrySample: true,
        isEngaged: false,
      }),
    ).toBe(false);
  });
});
