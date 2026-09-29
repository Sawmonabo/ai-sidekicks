// The contributions owners make their whole command set through: owner-scoped replace,
// first-contribution order, and the change signal.

import { describe, expect, it } from "vitest";

import {
  commandContributionRegistry,
  contributedKeybindings,
  subscribeToCommandContributions,
  type CommandContributionRelease,
} from "./command-contributions.js";
import type { CommandDefinition, Keybinding } from "./command-types.js";
import { commandRegistry } from "./window-command-registry.js";

/** One act, named by its id and doing nothing — the cases are about the wiring. */
function inertCommand(id: string): CommandDefinition {
  return { id, title: id, group: "Test", run: () => undefined };
}

/**
 * Withdraw every contribution a case made.
 *
 * The release the door handed back, and never a second empty contribution: an empty
 * one supersedes rather than withdraws, so the register would keep the case's entry
 * and the next case would compose on top of it. Called from a `finally`, which is
 * this file's own idiom for leaving the module-scoped registry as it was found.
 */
function releaseAll(...releases: readonly CommandContributionRelease[]): void {
  for (const release of releases) {
    release();
  }
}

describe("command contributions — one owner's whole set, contributed together", () => {
  it("registers the commands and publishes the chords together", () => {
    const release = commandContributionRegistry.contribute({
      owner: "contribution-test-alone",
      commands: [inertCommand("contribution-test.act")],
      keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.act" }],
    });
    try {
      expect(commandRegistry.has("contribution-test.act")).toBe(true);
      expect(contributedKeybindings()).toStrictEqual([
        { chord: "$mod+Shift+7", commandId: "contribution-test.act" },
      ]);
    } finally {
      releaseAll(release);
    }
  });

  it("replaces its own rows when a family contributes twice, and nobody else's", () => {
    // Composition is idempotent everywhere else in the console, and this door is
    // run again by a hot reload and by every test that composes the families. An
    // additive door would raise on the second pass instead.
    const releaseNeighbour = commandContributionRegistry.contribute({
      owner: "contribution-test-neighbour",
      commands: [inertCommand("contribution-test.kept")],
      keyBindings: [{ chord: "$mod+Shift+8", commandId: "contribution-test.kept" }],
    });
    const releaseFirst = commandContributionRegistry.contribute({
      owner: "contribution-test-replaced",
      commands: [inertCommand("contribution-test.first")],
      keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.first" }],
    });
    // The re-contribution the seat performs, in the order React performs it: the
    // previous effect's cleanup runs before the new one contributes, so the owner
    // holds one live entry and this is a replace rather than a supersede.
    releaseFirst();
    const releaseSecond = commandContributionRegistry.contribute({
      owner: "contribution-test-replaced",
      commands: [inertCommand("contribution-test.second")],
      keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.second" }],
    });
    try {
      expect(commandRegistry.has("contribution-test.first")).toBe(false);
      expect(commandRegistry.has("contribution-test.second")).toBe(true);
      expect(commandRegistry.has("contribution-test.kept")).toBe(true);
      // The replacing family keeps the slot its FIRST contribution gave it, so a
      // re-composition cannot reorder the window's chords under a sibling.
      expect(contributedKeybindings().map((binding) => binding.commandId)).toStrictEqual([
        "contribution-test.kept",
        "contribution-test.second",
      ]);
    } finally {
      releaseAll(releaseNeighbour, releaseSecond);
    }
  });

  it("tells a listener that the chords changed, and stops when it unsubscribes", () => {
    // The signal is what makes a family composed AFTER the window installed its
    // table reachable at all. Without it the chord is bound into a list nothing
    // re-reads, which is a keypress that does nothing and reports nothing.
    let signalCount = 0;
    const stopWatching = subscribeToCommandContributions(() => {
      signalCount += 1;
    });

    const release = commandContributionRegistry.contribute({
      owner: "contribution-test-signal",
      commands: [inertCommand("contribution-test.act")],
      keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.act" }],
    });
    try {
      const afterContribution = signalCount;
      stopWatching();
      release();

      expect(afterContribution).toBe(1);
      expect(signalCount).toBe(1);
    } finally {
      stopWatching();
      releaseAll(release);
    }
  });

  it("has already written the contribution when the listener reads it", () => {
    // Negative control for the emit's POSITION. A signal raised before the map is
    // written hands the listener the previous table, and every assertion above
    // still passes — the listener is the only thing that can tell.
    let chordsSeenByListener: readonly Keybinding[] = [];
    const stopWatching = subscribeToCommandContributions(() => {
      chordsSeenByListener = contributedKeybindings();
    });

    const release = commandContributionRegistry.contribute({
      owner: "contribution-test-late-read",
      commands: [inertCommand("contribution-test.act")],
      keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.act" }],
    });
    try {
      expect(chordsSeenByListener.map((binding) => binding.commandId)).toStrictEqual([
        "contribution-test.act",
      ]);
    } finally {
      stopWatching();
      releaseAll(release);
    }
  });

  it("negative control: no chord this file contributed survives it", () => {
    // Without this every case above would pass against a door whose withdrawal did
    // nothing, and the ordering assertion would be reading the case before it.
    expect(contributedKeybindings()).toStrictEqual([]);
    expect(commandRegistry.has("contribution-test.act")).toBe(false);
    expect(commandRegistry.has("contribution-test.kept")).toBe(false);
  });
});
