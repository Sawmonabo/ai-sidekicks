// The sidebar's chords, driven through the real dispatch rather than around it.
//
// The point of routing the cursor through `CommandRegistry` and `KeyBindingTable`
// is that the console has one command list and one keyboard; a test that called
// the model's methods directly would prove the model works and say nothing about
// whether a key ever reaches it. So every case here dispatches a real
// `KeyboardEvent` at a real element the table is installed on.
//
// The text-entry case is the one that would be silently wrong. The sidebar's
// filter field lives inside the element the chords are installed on, and `j` in
// that field must type a `j`. The table already decides that, which is exactly
// why the sidebar must not have its own guard — two answers to "is this a text
// field" is one more than the number that can be right.

import { afterEach, describe, expect, it } from "vitest";

import {
  KeyBindingTable,
  RAIL_NAVIGATION_DETAILS,
  consoleKeyBindings,
  type KeyBinding,
} from "../../palette/index.js";
import { SIDEBAR_SECTION_IDS, type ConsolePaneAddress } from "../../seats/index.js";
import {
  SIDEBAR_COMMAND_IDS,
  SIDEBAR_KEY_BINDINGS,
  SidebarKeyboard,
  sidebarCommands,
} from "./sidebar-commands.js";
import { SidebarModel } from "./sidebar-model.js";

interface KeyboardHarness {
  readonly model: SidebarModel;
  readonly container: HTMLElement;
  readonly filterField: HTMLInputElement;
  readonly openedPanes: ConsolePaneAddress[];
  readonly focusedSections: string[];
  readonly keyboard: SidebarKeyboard;
}

function mountKeyboard(): KeyboardHarness {
  const model = new SidebarModel({ sessionId: "session-sidebar-chords" });
  const container = document.createElement("nav");
  const filterField = document.createElement("input");
  filterField.type = "search";
  container.append(filterField);
  document.body.append(container);
  const openedPanes: ConsolePaneAddress[] = [];
  const focusedSections: string[] = [];
  const keyboard = new SidebarKeyboard(model, {
    openPane: (address) => openedPanes.push(address),
    focusSection: (id) => focusedSections.push(id),
  });
  keyboard.install(container);
  return { model, container, filterField, openedPanes, focusedSections, keyboard };
}

function press(target: EventTarget, code: string, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true }));
}

afterEach(() => {
  // Each case mounts its own container and its own keyboard, so the whole of the
  // teardown is dropping the elements: a detached container carries its listener
  // away with it, and the next case's table is a different instance. Tracking the
  // harness in a module-scope binding to dispose it would be state this file has
  // no other use for.
  document.body.replaceChildren();
});

describe("sidebar chords — the DOM-free cursor", () => {
  it("moves the cursor on j and k, and moves focus with it", () => {
    const { model, container, focusedSections } = mountKeyboard();
    press(container, "KeyJ", "j");
    expect(model.snapshot.cursorSectionId).toBe(SIDEBAR_SECTION_IDS[1]);
    press(container, "KeyK", "k");
    expect(model.snapshot.cursorSectionId).toBe(SIDEBAR_SECTION_IDS[0]);
    // Focus follows because the cursor is invisible otherwise: it lives in the
    // model, and a person driving by keyboard is told where they are by focus.
    expect(focusedSections).toStrictEqual([SIDEBAR_SECTION_IDS[1], SIDEBAR_SECTION_IDS[0]]);
  });

  it("expands the cursored section on Space and opens a pane on Enter", () => {
    const { model, container, openedPanes } = mountKeyboard();
    press(container, "Space", " ");
    expect(model.isSectionOpen(SIDEBAR_SECTION_IDS[0])).toBe(true);

    // `runs` is the one section whose subject has a session-scoped pane kind.
    model.setCursor("runs");
    press(container, "Enter", "Enter");
    expect(openedPanes).toStrictEqual([{ kind: "runs" }]);
  });

  it("expands rather than opening a pane where the section names none", () => {
    const { model, container, openedPanes } = mountKeyboard();
    model.setCursor("members");
    press(container, "Enter", "Enter");
    expect(openedPanes).toStrictEqual([]);
    expect(model.isSectionOpen("members")).toBe(true);
  });

  it("negative control: a chord the sidebar does not bind moves nothing", () => {
    // Without this the cases above would pass over a table that ran the first
    // command for any key at all.
    const { model, container, focusedSections } = mountKeyboard();
    press(container, "KeyQ", "q");
    expect(model.snapshot.cursorSectionId).toBe(SIDEBAR_SECTION_IDS[0]);
    expect(focusedSections).toStrictEqual([]);
  });
});

describe("sidebar chords — the filter field keeps its letters", () => {
  it("does not move the cursor when j is typed into the filter", () => {
    const { model, filterField } = mountKeyboard();
    press(filterField, "KeyJ", "j");
    expect(model.snapshot.cursorSectionId).toBe(SIDEBAR_SECTION_IDS[0]);
  });

  it("negative control: the same press outside the field does move the cursor", () => {
    // This is what makes the case above a claim about text entry rather than
    // about the event never having been delivered at all.
    const { model, container } = mountKeyboard();
    press(container, "KeyJ", "j");
    expect(model.snapshot.cursorSectionId).toBe(SIDEBAR_SECTION_IDS[1]);
  });
});

describe("sidebar chords — the contribution itself", () => {
  it("contributes exactly the four acts the design names, each with a chord", () => {
    const model = new SidebarModel({ sessionId: "session-sidebar-contribution" });
    const commands = sidebarCommands(model, {
      openPane: () => undefined,
      focusSection: () => undefined,
    });
    expect(commands.map((command) => command.id)).toStrictEqual(Object.values(SIDEBAR_COMMAND_IDS));

    const keyboard = new SidebarKeyboard(model, {
      openPane: () => undefined,
      focusSection: () => undefined,
    });
    try {
      // A chord read back from the table that dispatches, so a hint can never
      // print a chord that would not fire.
      expect(keyboard.chordFor(SIDEBAR_COMMAND_IDS.cursorNext)).toBe("KeyJ");
      expect(keyboard.chordFor("sidebar.notAnAct")).toBeUndefined();
    } finally {
      keyboard.dispose();
    }
  });

  it("negative control: disposing takes the listener down", () => {
    const { model, container, keyboard } = mountKeyboard();
    keyboard.dispose();
    press(container, "KeyJ", "j");
    expect(model.snapshot.cursorSectionId).toBe(SIDEBAR_SECTION_IDS[0]);
    // Disposing twice is the unmount-after-error path and must not throw.
    expect(() => {
      keyboard.dispose();
    }).not.toThrow();
  });
});

describe("sidebar chords — a held key is one act", () => {
  it("ignores an auto-repeat", () => {
    const { model, container } = mountKeyboard();
    container.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyJ", key: "j", repeat: true, bubbles: true }),
    );
    expect(model.snapshot.cursorSectionId).toBe(SIDEBAR_SECTION_IDS[0]);
  });
});

// The window's chord table, read the way the frame reads it: `consoleKeyBindings()`
// is what `frame-commands.ts` installs on `window`, and it is the frame's own chords
// followed by every family's contribution.
//
// CALLED, NOT HOISTED INTO A CONSTANT, for that function's own reason: the families'
// half is not known when a module is evaluated, so a constant read here would pin
// whatever had been composed by the time this file was imported — an ordering nobody
// declared and nothing reports, and one that would make this claim quietly narrower
// than the table the window actually installs.

/**
 * Which of `sidebarBindings` the window's table would eat, as one line each.
 *
 * `KeyBindingTable.conflictsIn` is the console's OWN comparator, run over the two
 * tables as one candidate set — not a string equality over the chords. That matters
 * twice: `$mod+1` and `$mod+Digit1` are one keystroke and only the comparator knows
 * it, and a rule this file re-implemented would be a second answer to a question the
 * palette already answers for every other binding in the console.
 *
 * Filtered to pairs that CROSS the two tables, because a conflict inside either one
 * is that table's own affair and `keybinding-conflicts.test.ts` already owns it.
 */
function windowCollisionsWith(sidebarBindings: readonly KeyBinding[]): readonly string[] {
  const sidebarCommandIds = new Set(sidebarBindings.map((binding) => binding.commandId));
  return KeyBindingTable.conflictsIn([...consoleKeyBindings(), ...sidebarBindings])
    .filter(
      (conflict) =>
        conflict.commandIds.some((commandId) => sidebarCommandIds.has(commandId)) &&
        conflict.commandIds.some((commandId) => !sidebarCommandIds.has(commandId)),
    )
    .map((conflict) => `${conflict.chord}: ${conflict.commandIds.join(" then ")}`);
}

describe("sidebar chords — none of them is a chord the window already binds", () => {
  it("binds no chord the window's table binds", () => {
    // WHY THIS IS A GATE AND NOT A REVIEW NOTE. The sidebar's table is installed on
    // the sidebar ELEMENT and the window's on `window`, and both install with
    // `capture: true` — so the window's listener runs first on the way DOWN, and a
    // match there calls `preventDefault` and `stopPropagation`. A sidebar chord equal
    // to a window chord therefore never reaches the sidebar at all: the act simply
    // stops happening, with nothing thrown, nothing logged, and no conflict reported,
    // because the two tables validate separately and neither has ever seen the other.
    expect(windowCollisionsWith(SIDEBAR_KEY_BINDINGS)).toStrictEqual([]);
  });

  it("planted control: a sidebar chord equal to a window chord is reported", () => {
    // Without this the claim above would pass over a filter that reported nothing.
    const planted: readonly KeyBinding[] = [
      ...SIDEBAR_KEY_BINDINGS,
      {
        chord: RAIL_NAVIGATION_DETAILS.settings.chord,
        commandId: SIDEBAR_COMMAND_IDS.cursorNext,
      },
    ];
    expect(windowCollisionsWith(planted)).toStrictEqual([
      `${RAIL_NAVIGATION_DETAILS.settings.chord}: frame.goToSettings then ${SIDEBAR_COMMAND_IDS.cursorNext}`,
    ]);
  });

  it("planted control: a differently spelled collision is still one keystroke", () => {
    // The half a string equality would miss, and the reason the comparator is
    // borrowed rather than re-written here: the rail binds `$mod+1` and this binds
    // `$mod+Digit1`, which are the same press typed two ways.
    const planted: readonly KeyBinding[] = [
      ...SIDEBAR_KEY_BINDINGS,
      { chord: "$mod+Digit1", commandId: SIDEBAR_COMMAND_IDS.cursorPrevious },
    ];
    expect(windowCollisionsWith(planted)).toStrictEqual([
      `${RAIL_NAVIGATION_DETAILS.sessions.chord}: frame.goToSessions then ${SIDEBAR_COMMAND_IDS.cursorPrevious}`,
    ]);
  });

  it("negative control: a chord in neither table collides with nothing", () => {
    // And the filter is not simply reporting every sidebar binding it is handed.
    const planted: readonly KeyBinding[] = [
      ...SIDEBAR_KEY_BINDINGS,
      { chord: "$mod+KeyQ", commandId: SIDEBAR_COMMAND_IDS.toggleCursorSection },
    ];
    expect(windowCollisionsWith(planted)).toStrictEqual([]);
  });
});
