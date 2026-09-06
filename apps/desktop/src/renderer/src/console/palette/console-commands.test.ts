// The command door families contribute through, and the `when` vocabulary the
// console publishes to write clauses against.
//
// Two doors would be one too many: a family that reaches the registry directly
// and a family that goes through `registerConsoleCommand` are contributing the
// same thing by two paths, and the path that skips the door is the one that skips
// whatever the door later starts doing. The frame's own commands go through it
// too, so these cases drive the door rather than the registry behind it.
//
// The `when`-clause vocabulary is checked from both sides. A tuple that nothing
// reads at runtime is a claim about a set that no test can hold: it stays right
// only for as long as everyone remembers to edit two places, which is the exact
// failure the collapsed declaration exists to make impossible.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "../core/keyed-registry.js";
import {
  CONSOLE_WHEN_CLAUSE_KEYS,
  consoleCommandSurface,
  consoleCommands,
  consoleFamilyKeyBindings,
  registerConsoleCommand,
  registerConsoleCommands,
  subscribeToConsoleFamilyContributions,
  type ConsoleWhenClauseContext,
} from "./console-commands.js";
import type { ConsoleCommand, KeyBinding } from "./contributions.js";

/** Every key the console publishes, all false — the shape, not a situation. */
const NO_CONTEXT: ConsoleWhenClauseContext = {
  sessionActive: false,
  onSessions: false,
  onWorkspace: false,
  onWorkflows: false,
  onSettings: false,
  inAuxiliaryWindow: false,
};

/**
 * The compile-time control for the vocabulary.
 *
 * A context is typed to exactly the published keys, so an invented one is an
 * excess property the compiler refuses at the author's keyboard rather than a
 * clause that quietly evaluates false and hides the command. If the type were ever
 * widened to `Record<string, boolean>`, the suppressed error would stop occurring
 * and this directive would itself become the error.
 */
const CONTEXT_THE_COMPILER_REJECTS: ConsoleWhenClauseContext = {
  ...NO_CONTEXT,
  // @ts-expect-error — `sessionActiveish` is not a key the console publishes.
  sessionActiveish: false,
};

describe("console commands — the door families contribute through", () => {
  it("registers one command", () => {
    try {
      registerConsoleCommand({
        id: "console-commands-test.one",
        title: "One",
        group: "Test",
        run: () => undefined,
      });
      expect(consoleCommands.has("console-commands-test.one")).toBe(true);
    } finally {
      consoleCommands.unregister("console-commands-test.one");
    }
  });

  it("registers several atomically", () => {
    try {
      registerConsoleCommands([
        { id: "console-commands-test.a", title: "A", group: "Test", run: () => undefined },
        { id: "console-commands-test.b", title: "B", group: "Test", run: () => undefined },
      ]);
      expect(consoleCommands.has("console-commands-test.a")).toBe(true);
      expect(consoleCommands.has("console-commands-test.b")).toBe(true);
    } finally {
      consoleCommands.unregister("console-commands-test.a");
      consoleCommands.unregister("console-commands-test.b");
    }
  });

  it("leaves the registry untouched when one id in a batch is taken", () => {
    // Atomic is the whole reason the plural door exists. Half a family's commands
    // is a state no caller can reason about, and none of them unwinds it.
    try {
      registerConsoleCommand({
        id: "console-commands-test.taken",
        title: "Taken",
        group: "Test",
        run: () => undefined,
      });
      expect(() => {
        registerConsoleCommands([
          {
            id: "console-commands-test.fresh",
            title: "Fresh",
            group: "Test",
            run: () => undefined,
          },
          {
            id: "console-commands-test.taken",
            title: "Again",
            group: "Test",
            run: () => undefined,
          },
        ]);
      }).toThrow(DuplicateRegistrationError);
      expect(consoleCommands.has("console-commands-test.fresh")).toBe(false);
    } finally {
      consoleCommands.unregister("console-commands-test.taken");
      consoleCommands.unregister("console-commands-test.fresh");
    }
  });

  it("negative control: nothing this file registered survives it", () => {
    // Without this every case above would pass against a door that registered
    // into a registry nobody reads, and the `has` assertions would be reading
    // leftovers from the case before.
    expect(consoleCommands.has("console-commands-test.one")).toBe(false);
    expect(consoleCommands.has("console-commands-test.a")).toBe(false);
    expect(consoleCommands.has("console-commands-test.taken")).toBe(false);
  });
});

describe("console commands — the published when-clause vocabulary", () => {
  it("names exactly the keys the console's own context supplies", () => {
    // The tuple is the declaration and `ConsoleWhenClauseContext` is derived from
    // it, so the compiler already refuses a context that is missing a key or
    // invents one. This holds the other direction at runtime: that the tuple a
    // family READS is the same set, rather than a stale copy of it.
    expect([...CONSOLE_WHEN_CLAUSE_KEYS].sort()).toStrictEqual(Object.keys(NO_CONTEXT).sort());
  });

  it("negative control: a key nobody publishes is not in the vocabulary", () => {
    // Reads the object the `@ts-expect-error` above suppressed, so the directive
    // is a claim this file executes rather than a comment nobody runs.
    expect(Object.keys(CONTEXT_THE_COMPILER_REJECTS)).toContain("sessionActiveish");
    expect(CONSOLE_WHEN_CLAUSE_KEYS).not.toContain("sessionActiveish");
    expect(Object.keys(NO_CONTEXT)).not.toContain("sessionActiveish");
  });
});

/** One act, named by its id and doing nothing — the cases are about the wiring. */
function inertCommand(id: string): ConsoleCommand {
  return { id, title: id, group: "Test", run: () => undefined };
}

/**
 * Withdraw every owner a case composed as.
 *
 * An empty contribution is the withdrawal: the door replaces an owner's rows rather
 * than forgetting the owner, so this unregisters the commands and empties the chords
 * while leaving the slot. Called from a `finally`, which is this file's own idiom for
 * leaving the module-scoped registry as it was found.
 */
function withdraw(...owners: readonly string[]): void {
  for (const owner of owners) {
    consoleCommandSurface.contribute({ owner, commands: [], keyBindings: [] });
  }
}

describe("console commands — the seat a family contributes its whole set through", () => {
  it("registers the commands and publishes the chords together", () => {
    try {
      consoleCommandSurface.contribute({
        owner: "contribution-test-alone",
        commands: [inertCommand("contribution-test.act")],
        keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.act" }],
      });

      expect(consoleCommands.has("contribution-test.act")).toBe(true);
      expect(consoleFamilyKeyBindings()).toStrictEqual([
        { chord: "$mod+Shift+7", commandId: "contribution-test.act" },
      ]);
    } finally {
      withdraw("contribution-test-alone");
    }
  });

  it("replaces its own rows when a family contributes twice, and nobody else's", () => {
    // Composition is idempotent everywhere else in the console, and this door is
    // run again by a hot reload and by every test that composes the families. An
    // additive door would raise on the second pass instead.
    try {
      consoleCommandSurface.contribute({
        owner: "contribution-test-neighbour",
        commands: [inertCommand("contribution-test.kept")],
        keyBindings: [{ chord: "$mod+Shift+8", commandId: "contribution-test.kept" }],
      });
      consoleCommandSurface.contribute({
        owner: "contribution-test-replaced",
        commands: [inertCommand("contribution-test.first")],
        keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.first" }],
      });
      consoleCommandSurface.contribute({
        owner: "contribution-test-replaced",
        commands: [inertCommand("contribution-test.second")],
        keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.second" }],
      });

      expect(consoleCommands.has("contribution-test.first")).toBe(false);
      expect(consoleCommands.has("contribution-test.second")).toBe(true);
      expect(consoleCommands.has("contribution-test.kept")).toBe(true);
      // The replacing family keeps the slot its FIRST contribution gave it, so a
      // re-composition cannot reorder the window's chords under a sibling.
      expect(consoleFamilyKeyBindings().map((binding) => binding.commandId)).toStrictEqual([
        "contribution-test.kept",
        "contribution-test.second",
      ]);
    } finally {
      withdraw("contribution-test-neighbour", "contribution-test-replaced");
    }
  });

  it("tells a listener that the chords changed, and stops when it unsubscribes", () => {
    // The signal is what makes a family composed AFTER the window installed its
    // table reachable at all. Without it the chord is bound into a list nothing
    // re-reads, which is a keypress that does nothing and reports nothing.
    let signalCount = 0;
    const stopWatching = subscribeToConsoleFamilyContributions(() => {
      signalCount += 1;
    });

    try {
      consoleCommandSurface.contribute({
        owner: "contribution-test-signal",
        commands: [inertCommand("contribution-test.act")],
        keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.act" }],
      });
      const afterContribution = signalCount;
      stopWatching();
      withdraw("contribution-test-signal");

      expect(afterContribution).toBe(1);
      expect(signalCount).toBe(1);
    } finally {
      stopWatching();
      withdraw("contribution-test-signal");
    }
  });

  it("has already written the contribution when the listener reads it", () => {
    // Negative control for the emit's POSITION. A signal raised before the map is
    // written hands the listener the previous table, and every assertion above
    // still passes — the listener is the only thing that can tell.
    let chordsSeenByListener: readonly KeyBinding[] = [];
    const stopWatching = subscribeToConsoleFamilyContributions(() => {
      chordsSeenByListener = consoleFamilyKeyBindings();
    });

    try {
      consoleCommandSurface.contribute({
        owner: "contribution-test-late-read",
        commands: [inertCommand("contribution-test.act")],
        keyBindings: [{ chord: "$mod+Shift+7", commandId: "contribution-test.act" }],
      });

      expect(chordsSeenByListener.map((binding) => binding.commandId)).toStrictEqual([
        "contribution-test.act",
      ]);
    } finally {
      stopWatching();
      withdraw("contribution-test-late-read");
    }
  });

  it("negative control: no chord this file contributed survives it", () => {
    // Without this every case above would pass against a door whose withdrawal did
    // nothing, and the ordering assertion would be reading the case before it.
    expect(consoleFamilyKeyBindings()).toStrictEqual([]);
    expect(consoleCommands.has("contribution-test.act")).toBe(false);
    expect(consoleCommands.has("contribution-test.kept")).toBe(false);
  });
});
