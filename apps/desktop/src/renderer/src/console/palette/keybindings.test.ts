// One listener, however many times the table is installed and disposed.
//
// The "exactly one listener" guarantee is stated in this module's header and
// enforced by a single field holding the current disposer. That field is what a
// STALE disposer can lie about: a disposer returned by an installation that has
// already been replaced still cleared the field, so the table reported itself
// uninstalled while the newer listener was still attached, the next `install` was
// admitted, and every press ran its command twice. Nothing above the table can
// see that — the registry is asked twice and answers twice, correctly, both
// times — so the claim has to be held here, on the real table, with a real
// listener target and a real dispatched press.

import { describe, expect, it } from "vitest";

import { CommandRegistry } from "./command-registry.js";
import type { KeyBinding } from "./contributions.js";
import { KeyBindingTable, type KeyBindingTarget } from "./keybindings.js";

/** A chord with no modifiers, so the press below needs none either. */
const CHORD = "KeyJ";

const COMMAND_ID = "test.jump";

const BINDINGS: readonly KeyBinding[] = [{ chord: CHORD, commandId: COMMAND_ID }];

/** What one installed table needs, plus the counter its command increments. */
interface TableUnderTest {
  readonly table: KeyBindingTable;
  readonly target: KeyBindingTarget & EventTarget;
  /** How many times the bound command has run. */
  runCount: () => number;
}

function buildTable(): TableUnderTest {
  let runs = 0;
  const registry = new CommandRegistry();
  registry.register({
    id: COMMAND_ID,
    title: "Jump somewhere",
    group: "Navigate",
    run: () => {
      runs += 1;
    },
  });
  const table = new KeyBindingTable({ registry, readContext: () => ({}) });
  table.setBindings(BINDINGS);
  return { table, target: new EventTarget(), runCount: () => runs };
}

function pressChord(target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { code: CHORD, key: "j" }));
}

describe("KeyBindingTable — a stale disposer cannot orphan the live listener", () => {
  it("keeps the table installed when a replaced installation's disposer is called again", () => {
    const { table, target, runCount } = buildTable();

    const firstDisposer = table.install(target);
    firstDisposer();
    table.install(target);

    // The disposer of an installation that was already replaced. It owns nothing
    // any more, so it must not report the table uninstalled.
    firstDisposer();

    expect(table.installed).toBe(true);
    expect(() => table.install(target)).toThrow(/already installed/);

    pressChord(target);
    expect(runCount()).toBe(1);
  });

  it("is idempotent: disposing the current installation twice detaches once and leaves it detached", () => {
    const { table, target, runCount } = buildTable();

    const disposer = table.install(target);
    disposer();
    disposer();

    expect(table.installed).toBe(false);
    pressChord(target);
    expect(runCount()).toBe(0);
  });

  it("negative control: install, dispose, install still runs the command exactly once per press", () => {
    // Without this, a table that refused every second installation outright — or
    // whose disposer detached nothing — would satisfy the two cases above and
    // leave the keyboard dead after the first dispose.
    const { table, target, runCount } = buildTable();

    table.install(target)();
    const secondDisposer = table.install(target);

    pressChord(target);
    expect(runCount()).toBe(1);

    secondDisposer();
    pressChord(target);
    expect(runCount()).toBe(1);
    expect(table.installed).toBe(false);
  });
});
