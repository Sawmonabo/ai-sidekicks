// One listener, however many times the table is installed and disposed. A stale disposer must not
// clear the installed marker, or the next `install` is admitted and every press runs twice; only
// the real table with a real target and press can show this.

import { describe, expect, it } from "vitest";

import { CommandRegistry } from "../commands/command-registry.js";
import { type Keybinding } from "../commands/command-types.js";
import { KeybindingTable, type KeybindingTarget } from "./keybinding-table.js";

/** A chord with no modifiers, so the press needs none. */
const CHORD = "KeyJ";

const COMMAND_ID = "test.jump";

const BINDINGS: readonly Keybinding[] = [{ chord: CHORD, commandId: COMMAND_ID }];

/** One table plus the counter its command increments. */
interface TableUnderTest {
  readonly table: KeybindingTable;
  readonly target: KeybindingTarget & EventTarget;
  /** How many times the bound command has run. */
  runCount: () => number;
}

function buildTable(): TableUnderTest {
  let runs = 0;
  const registry = new CommandRegistry();
  registry.register({
    id: COMMAND_ID,
    title: "Jump somewhere",
    group: "Console",
    run: () => {
      runs += 1;
    },
  });
  const table = new KeybindingTable({ registry, readContext: () => ({}) });
  table.setBindings(BINDINGS);
  return { table, target: new EventTarget(), runCount: () => runs };
}

function pressChord(target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { code: CHORD, key: "j" }));
}

describe("KeybindingTable — a stale disposer cannot orphan the live listener", () => {
  it("keeps the table installed when a replaced installation's disposer is called again", () => {
    const { table, target, runCount } = buildTable();

    const firstDisposer = table.install(target);
    firstDisposer();
    table.install(target);

    // A replaced installation's disposer owns nothing and must not report the table uninstalled.
    firstDisposer();

    expect(table.installed).toBe(true);
    expect(() => table.install(target)).toThrow(/already installed/);

    pressChord(target);
    expect(runCount()).toBe(1);
  });
});
