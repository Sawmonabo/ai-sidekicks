// One decoder, two readers: the printer (`lib/chord-format.ts`) and the conflict comparator.
// `$mod+k` and `$mod+KeyK` are one keystroke, so this asserts from the binding side the agreement
// that would otherwise fail silently: the printer's tests would pass while a key is double-bound.

import { describe, expect, it } from "vitest";

import { CommandRegistry } from "../commands/command-registry.js";
import { KeybindingConflictError, KeybindingTable } from "./keybinding-table.js";

describe("chord decoding — the comparator and the printer decode alike", () => {
  it("refuses two spellings of one keystroke as a conflict", () => {
    // `$mod+k` and `$mod+KeyK` are one chord, so installing both must be a conflict.
    const registry = new CommandRegistry();
    registry.registerAll([
      { id: "test.first", title: "First", group: "Test", run: () => undefined },
      { id: "test.second", title: "Second", group: "Test", run: () => undefined },
    ]);
    const table = new KeybindingTable({ registry, readContext: () => ({}) });

    expect(() => {
      table.setBindings([
        { chord: "$mod+k", commandId: "test.first" },
        { chord: "$mod+KeyK", commandId: "test.second" },
      ]);
    }).toThrow(KeybindingConflictError);
  });

  it("does not call two different keys a conflict", () => {
    // The negative half: over-aggressive normalization would refuse unrelated bindings.
    const registry = new CommandRegistry();
    registry.registerAll([
      { id: "test.first", title: "First", group: "Test", run: () => undefined },
      { id: "test.second", title: "Second", group: "Test", run: () => undefined },
    ]);
    const table = new KeybindingTable({ registry, readContext: () => ({}) });

    expect(() => {
      table.setBindings([
        { chord: "$mod+KeyK", commandId: "test.first" },
        { chord: "$mod+KeyJ", commandId: "test.second" },
      ]);
    }).not.toThrow();
  });
});
