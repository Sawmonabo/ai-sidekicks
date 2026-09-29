// WHICH RUN GROUPS ARE OPEN — the collapse state.
//
// Its own module beside `run-groups.ts` because the two change on different clocks: the
// fold changes when rows arrive and this changes when a person clicks. The behavior is
// fixed — run groups collapse once terminal and the live run group stays open — and the
// live arm here answers
// before any stored state is read, so that rule is a branch a caller cannot reach
// rather than one they have to remember.
//
// The stored state is the set of terminal run groups a person has OPENED, which is the
// smallest thing that has to be remembered: live run groups are open by rule, terminal
// run groups are folded by default, and everything else follows.

import { type RunGroup } from "./run-groups.js";

/**
 * Which run groups are open.
 *
 * Held apart from the fold because the two change on different clocks: the fold
 * changes when rows arrive and this changes when a person clicks. Keeping them in
 * one object would rebuild every run group's row-id array on a disclosure toggle.
 *
 * The stored state is the set of terminal run groups a person has OPENED, which is
 * the smallest thing that has to be remembered: live run groups are open by rule,
 * terminal run groups are folded by default, and everything else follows.
 */
export class RunGroupFoldState {
  readonly #openedTerminalRunIds = new Set<string>();

  /**
   * Whether this run group renders its body.
   *
   * The live arm answers before any stored state is read, which is what makes
   * rule 7's "the live run group stays open" unreachable rather than remembered.
   */
  public isOpen(runGroup: RunGroup): boolean {
    if (runGroup.lifecycle === "live") {
      return true;
    }
    return this.#openedTerminalRunIds.has(runGroup.runId);
  }

  /** Open a folded run group. It stays open until closed. */
  public open(runGroup: RunGroup): void {
    this.#openedTerminalRunIds.add(runGroup.runId);
  }

  /**
   * Fold a run group a person opened.
   *
   * A live run group is a no-op rather than an error: the caller is a click handler
   * on a header, and the header of a live run group offers no fold control at all,
   * so reaching here means the run ended between the render and the click.
   */
  public close(runGroup: RunGroup): boolean {
    if (runGroup.lifecycle === "live") {
      return false;
    }
    return this.#openedTerminalRunIds.delete(runGroup.runId);
  }

  /**
   * Fold every terminal run group — the console's "collapse all terminal run groups" offer.
   *
   * Returns how many were folded, so the command that invokes it can say what it
   * did rather than reporting success over a no-op.
   */
  public collapseAllTerminal(runGroups: readonly RunGroup[]): number {
    let folded = 0;
    for (const runGroup of runGroups) {
      if (this.close(runGroup)) {
        folded += 1;
      }
    }
    return folded;
  }

  /**
   * Terminal run groups a person has opened.
   *
   * The SET rather than a count, because the caller that renders the fold needs to
   * ask about one run group and the caller that reports on it needs `.size` — and two
   * accessors over one field is two things to keep agreeing.
   */
  public get openedTerminalRunIds(): ReadonlySet<string> {
    return this.#openedTerminalRunIds;
  }
}
