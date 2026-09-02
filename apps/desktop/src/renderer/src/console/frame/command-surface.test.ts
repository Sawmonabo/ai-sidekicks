// The command door, and the vocabulary the frame publishes to write against.
//
// Two doors would be one too many: a family that reaches the registry directly
// and a family that goes through `registerConsoleCommand` are contributing the
// same thing by two paths, and the path that skips the door is the one that skips
// whatever the door later starts doing. The frame's own commands now go through
// it too, so these cases drive the door rather than the registry behind it.
//
// The `when`-clause vocabulary is checked from both sides. A tuple that nothing
// reads at runtime is a claim about a set that no test can hold: it stays right
// only for as long as everyone remembers to edit two places, which is the exact
// failure the collapsed declaration exists to make impossible.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "../core/index.js";
import {
  FRAME_KEY_BINDINGS,
  FRAME_WHEN_CLAUSE_KEYS,
  consoleCommands,
  registerConsoleCommand,
  registerConsoleCommands,
  type FrameWhenClauseContext,
} from "./command-surface.js";

/** Every key the frame publishes, all false — the shape, not a situation. */
const NO_CONTEXT: FrameWhenClauseContext = {
  sessionActive: false,
  onSessions: false,
  onWorkspace: false,
  onSettings: false,
  inAuxiliaryWindow: false,
};

describe("command surface — the door families contribute through", () => {
  it("registers one command", () => {
    try {
      registerConsoleCommand({
        id: "command-surface-test.one",
        title: "One",
        group: "Test",
        run: () => undefined,
      });
      expect(consoleCommands.has("command-surface-test.one")).toBe(true);
    } finally {
      consoleCommands.unregister("command-surface-test.one");
    }
  });

  it("registers several atomically", () => {
    try {
      registerConsoleCommands([
        { id: "command-surface-test.a", title: "A", group: "Test", run: () => undefined },
        { id: "command-surface-test.b", title: "B", group: "Test", run: () => undefined },
      ]);
      expect(consoleCommands.has("command-surface-test.a")).toBe(true);
      expect(consoleCommands.has("command-surface-test.b")).toBe(true);
    } finally {
      consoleCommands.unregister("command-surface-test.a");
      consoleCommands.unregister("command-surface-test.b");
    }
  });

  it("leaves the registry untouched when one id in a batch is taken", () => {
    // Atomic is the whole reason the plural door exists. Half a family's commands
    // is a state no caller can reason about, and none of them unwinds it.
    try {
      registerConsoleCommand({
        id: "command-surface-test.taken",
        title: "Taken",
        group: "Test",
        run: () => undefined,
      });
      expect(() => {
        registerConsoleCommands([
          { id: "command-surface-test.fresh", title: "Fresh", group: "Test", run: () => undefined },
          { id: "command-surface-test.taken", title: "Again", group: "Test", run: () => undefined },
        ]);
      }).toThrow(DuplicateRegistrationError);
      expect(consoleCommands.has("command-surface-test.fresh")).toBe(false);
    } finally {
      consoleCommands.unregister("command-surface-test.taken");
      consoleCommands.unregister("command-surface-test.fresh");
    }
  });

  it("negative control: nothing this file registered survives it", () => {
    // Without this every case above would pass against a door that registered
    // into a registry nobody reads, and the `has` assertions would be reading
    // leftovers from the case before.
    expect(consoleCommands.has("command-surface-test.one")).toBe(false);
    expect(consoleCommands.has("command-surface-test.a")).toBe(false);
    expect(consoleCommands.has("command-surface-test.taken")).toBe(false);
  });
});

describe("command surface — the published when-clause vocabulary", () => {
  it("names exactly the keys the frame's own context supplies", () => {
    // The tuple is the declaration and `FrameWhenClauseContext` is derived from
    // it, so the compiler already refuses a context that is missing a key or
    // invents one. This holds the other direction at runtime: that the tuple a
    // family READS is the same set, rather than a stale copy of it.
    expect([...FRAME_WHEN_CLAUSE_KEYS].sort()).toStrictEqual(Object.keys(NO_CONTEXT).sort());
  });

  it("binds every frame chord to a key from that vocabulary", () => {
    const scopedChords = FRAME_KEY_BINDINGS.filter((binding) => binding.when !== undefined);
    // Non-empty, or the loop below proves nothing about anything.
    expect(scopedChords.length).toBeGreaterThan(0);
    for (const binding of scopedChords) {
      expect(FRAME_WHEN_CLAUSE_KEYS).toContain(binding.when);
    }
  });

  it("negative control: a key nobody publishes is not in the vocabulary", () => {
    expect(FRAME_WHEN_CLAUSE_KEYS).not.toContain("sessionActiveish");
    expect(Object.keys(NO_CONTEXT)).not.toContain("sessionActiveish");
  });
});
