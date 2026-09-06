// The door a family contributes its commands through, and the registry behind it.
//
// Two doors would be one too many: a family that reaches the registry directly and a
// family that goes through `registerConsoleCommand` are contributing the same thing by
// two paths, and the path that skips the door is the one that skips whatever the door
// later starts doing. The frame's own commands now go through it too, so these cases
// drive the door rather than the registry behind it.
//
// Beside the module rather than in the frame's suite, where it was while the door
// lived there: the door moved to this family because every input it has is this
// family's or below it, and a test of a module belongs beside the module.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "../core/keyed-registry.js";
import {
  consoleCommands,
  registerConsoleCommand,
  registerConsoleCommands,
} from "./console-commands.js";

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
