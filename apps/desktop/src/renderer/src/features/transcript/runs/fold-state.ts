// Which run groups are open. Its own module beside `groups.ts` because the fold changes when
// rows arrive and this changes when a person clicks. The stored state is only the terminal run
// groups a person has opened: live run groups are open by rule and terminal ones fold by default.

import { type RunGroup } from "./groups.js";

/**
 * Which run groups are open.
 *
 * Held apart from the fold so a disclosure toggle does not rebuild every run group's row-id
 * array.
 */
export class RunGroupFoldState {
  readonly #openedTerminalRunIds = new Set<string>();

  /**
   * Whether this run group renders its body.
   *
   * The live arm answers before any stored state is read, so "the live run group stays open"
   * cannot be broken by a caller.
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
   * A live run group is a no-op, not an error: its header offers no fold control, so reaching
   * here means the run ended between the render and the click.
   */
  public close(runGroup: RunGroup): boolean {
    if (runGroup.lifecycle === "live") {
      return false;
    }
    return this.#openedTerminalRunIds.delete(runGroup.runId);
  }

  /**
   * Fold every terminal run group, for the "collapse all terminal run groups" command.
   *
   * Returns how many were folded, so the command can say what it did.
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
   * The set, not a count: the renderer asks about one run group and the reporter needs `.size`.
   */
  public get openedTerminalRunIds(): ReadonlySet<string> {
    return this.#openedTerminalRunIds;
  }
}
