// WHICH CHAPTERS ARE OPEN — the collapse state, and the four conditions an
// auto-collapse is conjunctive on.
//
// Its own module beside `chapters.ts` because the two change on different clocks: the
// fold changes when rows arrive and this changes when a person clicks. `Spec-023
// §Meridian, the design language` rule 7 fixes the behaviour — "run chapters collapse
// once terminal and the live chapter stays open" — and the live arm here answers
// before any stored state is read, so that rule is a branch a caller cannot reach
// rather than one they have to remember.
//
// The stored state is the set of terminal chapters a person has OPENED, which is the
// smallest thing that has to be remembered: live chapters are open by rule, terminal
// chapters are folded by default, and everything else follows.

import { type LedgerChapter } from "./chapters.js";

/**
 * What the console knows about a chapter's place on screen, at the moment an
 * auto-collapse is considered.
 *
 * Every member is an OBSERVATION the caller made, never something this class
 * derives: this module makes auto-collapse conditional on geometry — only when the
 * chapter is off screen and only after one fresh geometry sample since the pane
 * was last hidden — and on engagement, and both live where the DOM is. A class
 * that guessed either would auto-collapse the chapter somebody was reading.
 */
export interface ChapterAutoCollapseObservation {
  readonly isOffScreen: boolean;
  /**
   * Whether the caller has measured this chapter since the pane was last hidden.
   * A pane that was hidden reports every chapter as off screen, so collapsing on
   * a stale sample would fold the whole log the moment a person came back to it.
   */
  readonly hasFreshGeometrySample: boolean;
  /** An open card, a selection, or focus inside the chapter. Never auto-collapses. */
  readonly isEngaged: boolean;
}

/**
 * Which chapters are open.
 *
 * Held apart from the fold because the two change on different clocks: the fold
 * changes when rows arrive and this changes when a person clicks. Keeping them in
 * one object would rebuild every chapter's row-id array on a disclosure toggle.
 *
 * The stored state is the set of terminal chapters a person has OPENED, which is
 * the smallest thing that has to be remembered: live chapters are open by rule,
 * terminal chapters are folded by default, and everything else follows.
 */
export class ChapterCollapseState {
  readonly #openedTerminalRunIds = new Set<string>();

  /**
   * Whether this chapter renders its body.
   *
   * The live arm answers before any stored state is read, which is what makes
   * rule 7's "the live chapter stays open" unreachable rather than remembered.
   */
  public isOpen(chapter: LedgerChapter): boolean {
    if (chapter.lifecycle === "live") {
      return true;
    }
    return this.#openedTerminalRunIds.has(chapter.runId);
  }

  /** Open a folded chapter. It stays open until closed. */
  public open(chapter: LedgerChapter): void {
    this.#openedTerminalRunIds.add(chapter.runId);
  }

  /**
   * Fold a chapter a person opened.
   *
   * A live chapter is a no-op rather than an error: the caller is a click handler
   * on a header, and the header of a live chapter offers no fold control at all,
   * so reaching here means the run ended between the render and the click.
   */
  public close(chapter: LedgerChapter): boolean {
    if (chapter.lifecycle === "live") {
      return false;
    }
    return this.#openedTerminalRunIds.delete(chapter.runId);
  }

  /**
   * Fold every terminal chapter — the console's "collapse all terminal chapters" offer.
   *
   * Returns how many were folded, so the command that invokes it can say what it
   * did rather than reporting success over a no-op.
   */
  public collapseAllTerminal(chapters: readonly LedgerChapter[]): number {
    let folded = 0;
    for (const chapter of chapters) {
      if (this.close(chapter)) {
        folded += 1;
      }
    }
    return folded;
  }

  /**
   * Fold a terminal chapter that has scrolled away, if every condition holds.
   *
   * Returns whether it folded, so the caller never has to re-derive the rule to
   * find out. All four conditions are conjunctive and each one is a separate way
   * the fold would be wrong: a live chapter is still being written, an on-screen
   * chapter is being read, a stale sample is a measurement of a hidden pane, and
   * an engaged chapter has somebody in it.
   */
  public autoCollapse(
    chapter: LedgerChapter,
    observation: ChapterAutoCollapseObservation,
  ): boolean {
    if (chapter.lifecycle === "live") {
      return false;
    }
    if (!observation.isOffScreen || !observation.hasFreshGeometrySample || observation.isEngaged) {
      return false;
    }
    return this.#openedTerminalRunIds.delete(chapter.runId);
  }

  /**
   * Terminal chapters a person has opened.
   *
   * The SET rather than a count, because the caller that renders the fold needs to
   * ask about one chapter and the caller that reports on it needs `.size` — and two
   * accessors over one field is two things to keep agreeing.
   */
  public get openedTerminalRunIds(): ReadonlySet<string> {
    return this.#openedTerminalRunIds;
  }
}
