// The sidebar's DOM-free cursor, as commands and chords rather than a keydown
// switch.
//
// THIS MODULE'S OWN RULE, because no committed document states it: a DOM-free
// cursor — `j` / `k` move, `Enter` opens, `Space` expands — with the cursor in store
// state so a re-render never loses it. Every clause of that is already built:
// `SidebarModel` holds the cursor outside the tree, `CommandRegistry` is the
// console's one command list, and `KeyBindingTable` is its one dispatch. So this
// module contributes; it implements no keyboard of its own.
//
// WHY A SIDEBAR-SCOPED REGISTRY AND TABLE, NOT THE WINDOW'S
//
// These chords are bare letters. A window-global `j` would take the letter away
// from every other surface in the console, which is exactly the failure the
// keybinding table's conflict rule exists to make loud — and it would be a real
// conflict, not a false one. The table takes any `EventTarget`, so the sidebar
// installs one listener on its own element and the chords are live only while
// focus is inside it. `CommandRegistry` is documented as one instance per window
// for the palette; a second instance for a scoped surface is the same class doing
// the same job at a smaller scope, not a second command system.
//
// THE FILTER FIELD IS HANDLED BY THE TABLE, NOT BY A GUARD HERE. `KeyBinding`
// defaults `allowInTextInput` to false and the table's own `isTextEntryTarget`
// decides what a text field is. Typing `j` into the filter therefore types a `j`,
// with no branch in this file that could disagree with the palette about what
// counts as text entry.

import {
  CommandRegistry,
  KeyBindingTable,
  type ConsoleCommand,
  type KeyBinding,
} from "../../palette/index.js";
import {
  type ConsolePaneAddress,
  type ConsolePaneOpener,
  type SidebarSectionId,
} from "../seats/index.js";
import { type SidebarModel } from "./sidebar-model.js";

/**
 * The pane a section header opens on `Enter`, where the section names one.
 *
 * Partial on purpose, and it is the honest shape: `runs` is the one section whose
 * subject has a SESSION-scoped pane kind. `artifacts` and `repos` open panes over
 * one artifact or one worktree — a row's act, reached through the section body's
 * own `openPane` — and a header that opened an entity pane with no entity would
 * be the deck guessing which one. A section with no entry here expands instead,
 * which is the other half of what the cursor's `Enter` means.
 */
const PANE_ADDRESS_BY_SECTION_ID: Partial<Readonly<Record<SidebarSectionId, ConsolePaneAddress>>> =
  {
    runs: { kind: "runs", entity: undefined },
  };

/** Command ids the sidebar contributes. Namespaced by surface, as the registry requires. */
export const SIDEBAR_COMMAND_IDS = {
  cursorNext: "sidebar.cursorNext",
  cursorPrevious: "sidebar.cursorPrevious",
  openCursorSection: "sidebar.openCursorSection",
  toggleCursorSection: "sidebar.toggleCursorSection",
} as const;

/**
 * The chords, in `tinykeys` syntax so `ChordHint` can print them for the host's
 * platform without this module knowing which platform that is.
 *
 * `KeyJ` / `KeyK` rather than `j` / `k`: the chord parser matches on `code` for
 * the letter forms, so the binding survives a layout where `j` is somewhere else.
 */
export const SIDEBAR_KEY_BINDINGS: readonly KeyBinding[] = [
  { chord: "KeyJ", commandId: SIDEBAR_COMMAND_IDS.cursorNext },
  { chord: "KeyK", commandId: SIDEBAR_COMMAND_IDS.cursorPrevious },
  { chord: "Enter", commandId: SIDEBAR_COMMAND_IDS.openCursorSection },
  { chord: "Space", commandId: SIDEBAR_COMMAND_IDS.toggleCursorSection },
];

/** What the acts need beyond the model: where a pane opens, and where focus goes. */
export interface SidebarCommandTargets {
  readonly openPane: ConsolePaneOpener;
  /**
   * Move keyboard focus onto a section's disclosure.
   *
   * The cursor is DOM-free — it lives in the model — but a person driving by
   * keyboard still has to be told where they are, and the platform's own answer
   * to that is focus. Handed in rather than reached for so this module holds no
   * DOM.
   */
  readonly focusSection: (id: SidebarSectionId) => void;
}

/**
 * The four acts, closing over one model.
 *
 * Built rather than declared at module scope for the reason `frame-commands.ts`
 * gives about its own: every act reads live state, so they are per sidebar and
 * are removed when it unmounts.
 */
export function sidebarCommands(
  model: SidebarModel,
  targets: SidebarCommandTargets,
): readonly ConsoleCommand[] {
  const moveTo = (offset: number): void => {
    model.moveCursor(offset);
    targets.focusSection(model.snapshot.cursorSectionId);
  };
  return [
    {
      id: SIDEBAR_COMMAND_IDS.cursorNext,
      title: "Move to the next sidebar section",
      group: "Sidebar",
      keywords: ["down", "next"],
      run: () => {
        moveTo(1);
      },
    },
    {
      id: SIDEBAR_COMMAND_IDS.cursorPrevious,
      title: "Move to the previous sidebar section",
      group: "Sidebar",
      keywords: ["up", "previous"],
      run: () => {
        moveTo(-1);
      },
    },
    {
      id: SIDEBAR_COMMAND_IDS.openCursorSection,
      title: "Open the sidebar section under the cursor",
      group: "Sidebar",
      run: () => {
        const cursorSectionId = model.snapshot.cursorSectionId;
        const address = PANE_ADDRESS_BY_SECTION_ID[cursorSectionId];
        if (address === undefined) {
          // No pane for this section, so `Enter` means the other thing it means:
          // open the section. Deliberately not a toggle — a person pressing
          // Enter on an open section wanted it open, and shutting it would be
          // the surface arguing with them.
          model.setSectionCollapsed(cursorSectionId, false);
          return;
        }
        targets.openPane(address);
      },
    },
    {
      id: SIDEBAR_COMMAND_IDS.toggleCursorSection,
      title: "Expand or collapse the sidebar section under the cursor",
      group: "Sidebar",
      run: () => {
        model.toggleSection(model.snapshot.cursorSectionId);
      },
    },
  ];
}

/**
 * The sidebar's keyboard: one registry, one table, one listener, one disposer.
 *
 * A class because the pairing is an invariant over state — a table installed
 * twice would run every act twice per press, and the table itself throws on that
 * — and because `install` / `dispose` have to be callable from an effect without
 * the component holding the three objects between them.
 */
export class SidebarKeyboard {
  readonly #registry = new CommandRegistry();
  readonly #table: KeyBindingTable;
  #detachListener: (() => void) | undefined;

  public constructor(model: SidebarModel, targets: SidebarCommandTargets) {
    this.#registry.registerAll(sidebarCommands(model, targets));
    this.#table = new KeyBindingTable({
      registry: this.#registry,
      // Every sidebar act is unconditional inside the sidebar, and the scope IS
      // the listener's target. An empty context is therefore the accurate one,
      // not a placeholder: a `when` clause here would name a key nothing
      // computes, and the fail-closed rule would hide the command.
      readContext: () => ({}),
    });
    this.#table.setBindings(SIDEBAR_KEY_BINDINGS);
  }

  /** The chord bound to one act, for `ChordHint`. `undefined` where none is live. */
  public chordFor(commandId: string): string | undefined {
    return this.#table.chordFor(commandId, {});
  }

  /** Attach the one listener to the sidebar's own element. */
  public install(target: HTMLElement): void {
    this.#detachListener = this.#table.install(target);
  }

  /** Detach. Safe to call when nothing is installed, so an effect cleanup is unconditional. */
  public dispose(): void {
    this.#detachListener?.();
    this.#detachListener = undefined;
    for (const commandId of Object.values(SIDEBAR_COMMAND_IDS)) {
      this.#registry.unregister(commandId);
    }
  }
}
