// Owner-scoped replace, first-contribution order and the change signal of command contributions.

import { describe, expect, it } from "vitest";

import {
  commandContributionRegistry,
  contributedKeybindings,
  subscribeToCommandContributions,
  type CommandContributionRelease,
} from "./command-contributions.js";
import type { CommandDefinition, Keybinding } from "./command-types.js";
import { commandRegistry } from "./window-command-registry.js";

/** A command that does nothing; the cases are about the wiring. */
function inertCommand(id: string): CommandDefinition {
  return { id, title: id, group: "Test", run: () => undefined };
}

/**
 * Withdraws every contribution a case made, from a `finally`. It uses the returned release,
 * never an empty contribution, which would supersede rather than withdraw.
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

  it("replaces its own rows when a feature contributes twice, and nobody else's", () => {
    // Hot reload and every composing test re-run `contribute`; an additive registry would raise.
    const releaseNeighbor = commandContributionRegistry.contribute({
      owner: "contribution-test-neighbor",
      commands: [inertCommand("contribution-test.kept")],
      keyBindings: [{ chord: "$mod+Shift+8", commandId: "contribution-test.kept" }],
    });
    const releaseFirst = commandContributionRegistry.contribute({
      owner: "contribution-test-replaced",
      commands: [inertCommand("contribution-test.first")],
      keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.first" }],
    });
    // React's order: the old effect's cleanup runs first, so this is a replace, not a supersede.
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
      // The replacing owner keeps its first-contribution position.
      expect(contributedKeybindings().map((binding) => binding.commandId)).toStrictEqual([
        "contribution-test.kept",
        "contribution-test.second",
      ]);
    } finally {
      releaseAll(releaseNeighbor, releaseSecond);
    }
  });

  it("tells a listener that the chords changed, and stops when it unsubscribes", () => {
    // Without the signal, a feature composed after the table was installed is never re-read.
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
    // Guards the emit's position: a signal before the map write hands the listener the old table.
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
    // Without this, a registry whose withdrawal did nothing would pass every case above.
    expect(contributedKeybindings()).toStrictEqual([]);
    expect(commandRegistry.has("contribution-test.act")).toBe(false);
    expect(commandRegistry.has("contribution-test.kept")).toBe(false);
  });
});
