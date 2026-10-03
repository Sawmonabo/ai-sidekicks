// The keyboard map: which chord runs which command, and how a keystroke becomes one.
//
// One row per command with its chord. A chord that collides in the same scope is never
// accepted without naming the collision, and a binding a platform reserves renders as
// unavailable with the reason. Every verdict about a binding set is
// the keybinding service's (`keybinding-audit.ts`); this module only joins the answers to rows.
//
// {@link readChordFromEvent} is the page's half of the recorder seam: the override store decides
// whether its chord can be bound. Chords use `KeyboardEvent.code` (`KeyK`, not `k`) where the
// host supplies one, as `chord-format.ts` does, so a binding stays on the same physical key on
// AZERTY and Dvorak.

import { reservedChordReason } from "@renderer/registries/keybindings/keybinding-audit.js";
import {
  type CommandDefinition,
  type Keybinding,
} from "@renderer/registries/commands/command-types.js";
import type { KeyboardMap } from "@shared/preload-api.js";
import { scoreSubsequence } from "@ai-sidekicks/search-ranking";
import {
  HOST_CHORD_PLATFORM,
  formatChordForPlatform,
  type ChordPlatform,
} from "@renderer/lib/chord-format.js";

/** One row of the keyboard map. */
export interface KeybindingRow {
  readonly commandId: string;
  readonly title: string;
  readonly group: string;
  /** The chord bound to this command, or `undefined` when it has none. */
  readonly chord: string | undefined;
  /** Present when the host takes this chord before the app can. */
  readonly unavailableReason: string | undefined;
  /**
   * The chord the app ships for this command, or `undefined` where it ships none.
   *
   * Carried so a reset control can name what it restores. It is the shipped table's answer,
   * never the effective one, which already has the overrides composed onto it.
   */
  readonly shippedChord: string | undefined;
  /**
   * True when this row's chord is a person's rather than the app's.
   *
   * Read from the override map, not by comparing chords: an explicitly unbound command and a
   * command that never had a chord both show none, and only the first has something to reset.
   */
  readonly overridden: boolean;
}

/**
 * What one keystroke means to a recorder that is listening for a chord.
 *
 * Each outcome is an act a person performed; `incomplete` is the one that does not end the
 * recording. Values rather than callbacks, so one pure function decides the grammar.
 */
export type ChordRecording =
  | { readonly outcome: "captured"; readonly chord: string }
  | { readonly outcome: "canceled" }
  | { readonly outcome: "cleared" }
  | {
      readonly outcome: "incomplete";
      /**
       * The modifiers held at this keystroke, in the order the app writes them.
       *
       * Carried so the row can show the app received each key while a chord is in
       * progress. Empty is a real answer: a bare key that is not yet a chord key.
       */
      readonly heldModifiers: readonly string[];
    };

/**
 * Everything but "not yet": what a recorder hands upward and stops recording on.
 *
 * Derived from the union so a new outcome joins both narrowings in one place.
 */
export type CompletedChordRecording = Exclude<ChordRecording, { readonly outcome: "incomplete" }>;

/** The two that change a binding. A cancellation changes nothing and is neither. */
export type AppliedChordRecording = Exclude<
  CompletedChordRecording,
  { readonly outcome: "canceled" }
>;

/**
 * Compose the rows a person reads, ordered by group then title as the palette orders the same
 * commands. Pure over its inputs.
 */
export function composeKeybindingRows(options: {
  readonly commands: readonly CommandDefinition[];
  readonly bindings: readonly Keybinding[];
  /**
   * The table the app ships, so each row can name the chord a reset restores. Required,
   * since an omitted table would render a reset that promises something it cannot name.
   */
  readonly shippedBindings: readonly Keybinding[];
  readonly overrides?: KeyboardMap;
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
        unavailableReason:
          bound === undefined ? undefined : reservedChordReason(bound.chord, platform),
        shippedChord: options.shippedBindings.find((binding) => binding.commandId === command.id)
          ?.chord,
        overridden: overrides[command.id] !== undefined,
      };
    });
}

/**
 * Narrow the rows to a typed query with the app's one matcher, as settings search does.
 *
 * A row offers what it draws: its title and its chord as the platform prints it (`⌘K`, not
 * the stored `$mod+KeyK`); the best score decides. An empty query answers every row in
 * composition order. An absent chord offers one candidate fewer rather than a placeholder,
 * which would rank a row for text nothing on it says.
 */
export function matchKeybindingRows(
  rows: readonly KeybindingRow[],
  query: string,
  platform: ChordPlatform = HOST_CHORD_PLATFORM,
): readonly KeybindingRow[] {
  const trimmedQuery = query.trim();
  if (trimmedQuery === "") {
    return rows;
  }
  const scored: { readonly row: KeybindingRow; readonly score: number }[] = [];
  for (const row of rows) {
    let best: number | undefined;
    for (const candidate of matchCandidatesOf(row, platform)) {
      const match = scoreSubsequence(candidate, trimmedQuery);
      if (match !== undefined && (best === undefined || match.score > best)) {
        best = match.score;
      }
    }
    if (best !== undefined) {
      scored.push({ row, score: best });
    }
  }
  // Stable sort over an ordered input, so equally good rows keep their places between keystrokes.
  return scored.sort((left, right) => right.score - left.score).map((entry) => entry.row);
}

/** The strings one row offers the scorer; the chord is dropped where the row has none. */
function matchCandidatesOf(row: KeybindingRow, platform: ChordPlatform): readonly string[] {
  return row.chord === undefined
    ? [row.title]
    : [row.title, formatChordForPlatform(row.chord, platform)];
}

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
 * `Escape` cancels and `Backspace` / `Delete` clear only when pressed alone, so
 * `$mod+Backspace` stays bindable. A modifier on its own completes nothing: on the way to
 * `⌘⇧K` a person passes through `⌘` and `⌘⇧`.
 */
export function readChordFromEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  platform: ChordPlatform = HOST_CHORD_PLATFORM,
): ChordRecording {
  const bare = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if (bare && event.key === "Escape") {
    return { outcome: "canceled" };
  }
  if (bare && (event.key === "Backspace" || event.key === "Delete")) {
    return { outcome: "cleared" };
  }
  if (MODIFIER_KEYS.has(event.key)) {
    return { outcome: "incomplete", heldModifiers: readHeldModifiersFromEvent(event, platform) };
  }
  const keyToken = event.code === "" ? event.key : event.code;
  if (keyToken === "") {
    return { outcome: "incomplete", heldModifiers: readHeldModifiersFromEvent(event, platform) };
  }
  return {
    outcome: "captured",
    chord: [...readHeldModifiersFromEvent(event, platform), keyToken].join("+"),
  };
}

/**
 * The modifiers held, in the order the app writes them.
 *
 * `$mod` is the platform's command modifier (Cmd on macOS, Ctrl elsewhere), the token shipped
 * chords are authored in. The other control key is written literally because `⌃` and `⌘` are
 * different keys on macOS. Exported because a release is read the same way as a press: the
 * event flags describe the state after the event, so one function answers "what is held now?"
 * and reads no `key` or `code`.
 */
export function readHeldModifiersFromEvent(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  platform: ChordPlatform = HOST_CHORD_PLATFORM,
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
