// The keyboard map: which chord runs which command, and how a person's next
// keystroke becomes one.
//
// `Spec-023 §Console Design (Meridian)` §Keyboard: "One row per command with its
// chord, its command id, and the when-grammar expression that scopes it …
// Conflict detection against the same when-scope, naming the command that already
// holds the chord … Never accepts a chord that collides in the same scope without
// naming the collision. Never silently drops a binding that a platform reserves;
// it renders as unavailable with the reason. Never writes a binding to a wire; the
// map is renderer-local."
//
// EVERY VERDICT ABOUT A BINDING SET IS THE KEYBINDING SERVICE'S OWN
//
// None of them is decided here, and none may be. `frame/keybinding-audit.ts` asks
// the service — the same service that will install the result — and this module
// only joins the answers to rows a person reads. The reserved-chord table lives
// there too: it was here, and the frame's override store became its second reader,
// so it moved DOWN to the lowest family both readers already import rather than
// being copied into one of them.
//
// THE RECORDER'S HALF IS HERE BECAUSE THE RECORDER IS
//
// {@link readChordFromEvent} turns one keystroke into a chord string. It is the
// page's half of the seam: what it produces is offered to the override store, which
// is the authority on whether the chord can be bound at all. Chords are composed in
// `KeyboardEvent.code` form wherever the host supplies one — `KeyK` rather than `k`
// — for the reason `primitives/chord-format.ts` gives about the same choice: `code`
// is layout-independent, so a binding stays on the same physical key on AZERTY and
// Dvorak.

import { reservedChordReason } from "../../../frame/keybinding-audit.js";
import type { KeybindingOverrideMap } from "../../../frame/keybinding-overrides.js";
import type { ConsoleCommand, KeyBinding } from "../../../palette/index.js";
import { scoreSubsequence } from "../../../palette/index.js";
import { HOST_CHORD_PLATFORM, type ChordPlatform } from "../../../primitives/index.js";

/** One row of the keyboard map. */
export interface KeybindingRow {
  readonly commandId: string;
  readonly title: string;
  readonly group: string;
  /** The chord bound to this command, or `undefined` when it has none. */
  readonly chord: string | undefined;
  /** The when-grammar expression scoping the BINDING, or `undefined` when global. */
  readonly whenExpression: string | undefined;
  /** Present when the host takes this chord before the console can. */
  readonly unavailableReason: string | undefined;
  /**
   * True when this row's chord is a person's rather than the console's.
   *
   * Read from the override map rather than by comparing the chord against the
   * shipped one: a person who explicitly unbound a command and a command that never
   * had a chord both show no chord, and only the first has something to reset.
   */
  readonly overridden: boolean;
}

/**
 * Compose the rows a person reads.
 *
 * Pure over its inputs, so the ordering, the binding join, and the reserved
 * marking are all testable without a registry, a table, or a DOM. Ordered by group
 * and then title — the order the palette already puts these same commands in, so
 * one console does not have two ideas about how its acts are arranged.
 */
export function composeKeybindingRows(options: {
  readonly commands: readonly ConsoleCommand[];
  readonly bindings: readonly KeyBinding[];
  readonly overrides?: KeybindingOverrideMap;
  readonly platform?: ChordPlatform;
}): readonly KeybindingRow[] {
  const platform = options.platform ?? HOST_CHORD_PLATFORM;
  const overrides = options.overrides ?? {};
  return [...options.commands]
    .sort(
      (left, right) =>
        left.group.localeCompare(right.group) || left.title.localeCompare(right.title),
    )
    .map((command): KeybindingRow => {
      const bound = options.bindings.find((binding) => binding.commandId === command.id);
      return {
        commandId: command.id,
        title: command.title,
        group: command.group,
        chord: bound?.chord,
        // The BINDING's scope and not the command's: a command may be offered
        // everywhere while its chord is live in one place, and the row is about
        // the chord.
        whenExpression: bound?.when,
        unavailableReason:
          bound === undefined ? undefined : reservedChordReason(bound.chord, platform),
        overridden: overrides[command.id] !== undefined,
      };
    });
}

/** A chord this window is holding for a command it cannot find. */
export interface StaleKeybindingOverrideRow {
  readonly commandId: string;
  /** The chord the override reserves. Always a string: a cleared override reserves none. */
  readonly chord: string;
}

/**
 * The overrides that belong to no command this build has.
 *
 * An upgrade that removes or renames a command leaves its stored override behind,
 * and the override store admits it deliberately — commands register at module scope
 * as families load, so validating a hydrated key against the registry would delete a
 * legitimate override for a family that had not registered yet, which is a worse
 * failure than the one this fixes. `composeEffectiveBindings` then APPENDS the
 * unknown command's binding, which is what makes a command shipping with no chord
 * bindable at all — so the entry reserves its chord and the rows above, built from
 * the registered commands, cannot show it. Left alone it is invisible, cannot be
 * reset, and refuses somebody else's rebinding by naming an id nothing on the page
 * holds.
 *
 * So the answer is legibility rather than deletion: these are exactly the entries the
 * page draws with a Remove control beside them. Pure over its inputs — a `null`
 * override reserves no chord and is not one of these, and a key the shipped table
 * binds is a rebinding of a real command rather than a leftover, whatever the command
 * registry happens to hold at this moment.
 *
 * Ordered by command id, which is the only thing a stale entry has to be ordered by.
 *
 * `shippedBindings` is the table the console SHIPS and never the effective one. The
 * effective table is the shipped table with these very entries appended, so passing
 * it would make every stale entry claim itself and this function answer nothing.
 */
export function composeStaleOverrideRows(options: {
  readonly commands: readonly ConsoleCommand[];
  readonly shippedBindings: readonly KeyBinding[];
  readonly overrides: KeybindingOverrideMap;
}): readonly StaleKeybindingOverrideRow[] {
  const claimed = new Set<string>([
    ...options.commands.map((command) => command.id),
    ...options.shippedBindings.map((binding) => binding.commandId),
  ]);
  const stale: StaleKeybindingOverrideRow[] = [];
  for (const commandId of Object.keys(options.overrides).sort()) {
    const override = options.overrides[commandId];
    if (typeof override === "string" && !claimed.has(commandId)) {
      stale.push({ commandId, chord: override });
    }
  }
  return stale;
}

/**
 * Narrow the rows to a typed query.
 *
 * The console's one matcher, reached the way settings search reaches it
 * (`settings-page-registry.ts`) — imported, never re-implemented. A row offers its
 * title, its command id, and its group; the best of the three decides. An empty
 * query answers every row in composition order, which is what the page shows
 * before anyone has typed.
 */
export function matchKeybindingRows(
  rows: readonly KeybindingRow[],
  query: string,
): readonly KeybindingRow[] {
  const trimmedQuery = query.trim();
  if (trimmedQuery === "") {
    return rows;
  }
  const scored: { readonly row: KeybindingRow; readonly score: number }[] = [];
  for (const row of rows) {
    let best: number | undefined;
    for (const candidate of [row.title, row.commandId, row.group]) {
      const match = scoreSubsequence(candidate, trimmedQuery);
      if (match !== undefined && (best === undefined || match.score > best)) {
        best = match.score;
      }
    }
    if (best !== undefined) {
      scored.push({ row, score: best });
    }
  }
  // Stable sort over an already-ordered input, so two equally-good rows never
  // swap places between keystrokes.
  return scored.sort((left, right) => right.score - left.score).map((entry) => entry.row);
}

/**
 * What one keystroke means to a recorder that is listening for a chord.
 *
 * Four outcomes and each is an act a person performed, not a state the recorder is
 * in: three of them end the recording and `incomplete` is the one that does not.
 * They are values rather than callbacks so the whole grammar is decided in one pure
 * function a test can drive with a synthetic event.
 */
export type ChordRecording =
  | { readonly outcome: "captured"; readonly chord: string }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "cleared" }
  | { readonly outcome: "incomplete" };

/**
 * Everything but "not yet" — what a recorder hands upward and stops recording on.
 *
 * Derived from the union above rather than written beside it: a fifth outcome joins
 * both of these narrowings by being added in one place, and a reader can see which
 * arms each caller is answerable for without a comment claiming it.
 */
export type CompletedChordRecording = Exclude<ChordRecording, { readonly outcome: "incomplete" }>;

/** The two that change a binding. A cancellation changes nothing and is neither. */
export type AppliedChordRecording = Exclude<
  CompletedChordRecording,
  { readonly outcome: "cancelled" }
>;

/** Keys that are only ever held, never the key OF a chord. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Meta",
  "OS",
  "Shift",
]);

/**
 * Read one keystroke as a chord, a cancellation, a clearing, or nothing yet.
 *
 * `Escape` cancels and `Backspace` / `Delete` clear, both only when pressed alone:
 * `$mod+Backspace` is a chord somebody may legitimately want, and a recorder that
 * treated it as a clearing would make that chord unbindable. A press of a modifier
 * on its own completes nothing — a person on their way to `⌘⇧K` passes through
 * `⌘` and `⌘⇧`, and a recorder that settled on the first of them would bind the
 * wrong chord every time.
 */
export function readChordFromEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  platform: ChordPlatform = HOST_CHORD_PLATFORM,
): ChordRecording {
  const bare = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if (bare && event.key === "Escape") {
    return { outcome: "cancelled" };
  }
  if (bare && (event.key === "Backspace" || event.key === "Delete")) {
    return { outcome: "cleared" };
  }
  if (MODIFIER_KEYS.has(event.key)) {
    return { outcome: "incomplete" };
  }
  const keyToken = event.code === "" ? event.key : event.code;
  if (keyToken === "") {
    return { outcome: "incomplete" };
  }
  return { outcome: "captured", chord: [...heldModifiers(event, platform), keyToken].join("+") };
}

/**
 * The modifiers held, in the order the console writes them.
 *
 * `$mod` is the platform's own command modifier — Cmd on macOS, Ctrl elsewhere —
 * which is the token every shipped chord is authored in, so a recorded chord and a
 * declared one read the same way. The OTHER control key is written literally,
 * because on macOS `⌃` and `⌘` are two different keys and a chord that folded them
 * together would install on the wrong one.
 */
function heldModifiers(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  platform: ChordPlatform,
): readonly string[] {
  const modifiers: string[] = [];
  const commandModifierHeld = platform === "darwin" ? event.metaKey : event.ctrlKey;
  if (commandModifierHeld) {
    modifiers.push("$mod");
  }
  if (platform === "darwin" ? event.ctrlKey : event.metaKey) {
    modifiers.push(platform === "darwin" ? "Control" : "Meta");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  return modifiers;
}
