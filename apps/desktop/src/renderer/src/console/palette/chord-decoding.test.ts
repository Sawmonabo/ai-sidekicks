// One decoder, two readers: the printer and the conflict comparator.
//
// `primitives/chord-format.ts` decodes `KeyK` to `K` so a keycap prints the letter.
// The binding table decodes the same token for a different reason: `$mod+k` and
// `$mod+KeyK` are two spellings of ONE keystroke, so installing both is a conflict
// and not two bindings that happen to fight at runtime.
//
// Those are two readers of one function, and this file asserts the agreement from
// the palette side — the side that would fail silently. If the two ever drift apart
// again, the printer's own tests still pass (it prints something) while the console
// quietly double-binds a key, which is the failure worth a test of its own.

import { describe, expect, it } from "vitest";

import { CommandRegistry } from "./command-registry.js";
import { KeyBindingConflictError, KeyBindingTable } from "./keybindings.js";

describe("chord decoding — the comparator and the printer decode alike", () => {
  it("refuses two spellings of one keystroke as a conflict", () => {
    // The printer's decoding and the conflict comparator's decoding are the same
    // function, and this is the half of that which is not about pixels: `$mod+k`
    // and `$mod+KeyK` ARE one chord, so installing both is a conflict rather than
    // two bindings that happen to fight at runtime. Were the two decoders to drift
    // apart again, this passes silently while the console double-binds a key.
    const registry = new CommandRegistry();
    registry.registerAll([
      { id: "test.first", title: "First", group: "Test", run: () => undefined },
      { id: "test.second", title: "Second", group: "Test", run: () => undefined },
    ]);
    const table = new KeyBindingTable({ registry, readContext: () => ({}) });

    expect(() => {
      table.setBindings([
        { chord: "$mod+k", commandId: "test.first" },
        { chord: "$mod+KeyK", commandId: "test.second" },
      ]);
    }).toThrow(KeyBindingConflictError);
  });

  it("does not call two different keys a conflict", () => {
    // The negative half: a comparator that normalised too aggressively — folding
    // `KeyK` to `K` and then `Keyboard` to `board`, say — would refuse bindings
    // that have nothing to do with each other.
    const registry = new CommandRegistry();
    registry.registerAll([
      { id: "test.first", title: "First", group: "Test", run: () => undefined },
      { id: "test.second", title: "Second", group: "Test", run: () => undefined },
    ]);
    const table = new KeyBindingTable({ registry, readContext: () => ({}) });

    expect(() => {
      table.setBindings([
        { chord: "$mod+KeyK", commandId: "test.first" },
        { chord: "$mod+KeyJ", commandId: "test.second" },
      ]);
    }).not.toThrow();
  });
});
