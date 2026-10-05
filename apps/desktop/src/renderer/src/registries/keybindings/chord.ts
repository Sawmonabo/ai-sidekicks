// One keystroke, parsed, matched and compared. The only tinykeys use is here: `parseKeybinding`
// turns `"$mod+KeyK"` into modifier sets and a key, and `matchKeybindingPress` matches a
// `KeyboardEvent` against a parsed press. `tinykeys()` itself is not used (see
// `keybinding-table.ts`). Printing and speaking chords lives in `lib/chord-format.ts`; the shared
// key decoder keeps the printer and the conflict comparator agreeing that `k` and `KeyK` are one
// key.

import { matchKeybindingPress, parseKeybinding, type KeybindingPress } from "tinykeys";
import { decodeChordKeyToken } from "#renderer/lib/chord-format.js";

/** Why a chord string was refused. */
export type ChordParseErrorKind = "empty-chord" | "sequence-unsupported" | "no-key";

/** A chord that parsed, or the reason it did not. */
export type ChordParseResult =
  | { readonly ok: true; readonly press: KeybindingPress }
  | { readonly ok: false; readonly kind: ChordParseErrorKind; readonly message: string };

/**
 * Parses a chord into the single press the table matches against. Multi-press sequences such
 * as `"g d"` are refused at install: supporting them needs a pending-press timer on the input path.
 */
export function parseChord(chord: string): ChordParseResult {
  const trimmed = chord.trim();
  if (trimmed.length === 0) {
    return { ok: false, kind: "empty-chord", message: "The chord is empty" };
  }
  const presses = parseKeybinding(trimmed);
  if (presses.length > 1) {
    return {
      ok: false,
      kind: "sequence-unsupported",
      message: `"${trimmed}" is a sequence of presses, and a shortcut is one chord`,
    };
  }
  const press = presses[0];
  if (press === undefined) {
    return { ok: false, kind: "empty-chord", message: "The chord is empty" };
  }
  const key = press[2];
  if (typeof key === "string" && key.length === 0) {
    return { ok: false, kind: "no-key", message: `"${trimmed}" names modifiers but no key` };
  }
  return { ok: true, press };
}

/** Whether this event satisfies this parsed chord; tinykeys owns the semantics. */
export function chordMatchesEvent(press: KeybindingPress, event: KeyboardEvent): boolean {
  return matchKeybindingPress(event, press);
}

/**
 * A comparison key for a parsed press (required modifiers, optional modifiers, key), normalized
 * so two spellings of one keystroke collide. A regular-expression key is compared by its source.
 */
export function normalizePressForComparison(press: KeybindingPress): string {
  const [requiredModifiers, optionalModifiers, key] = press;
  const required = [...requiredModifiers].sort().join("+");
  const optional = [...optionalModifiers].sort().join("+");
  const keyText = typeof key === "string" ? normalizeKeyToken(key) : `re:${key.source}`;
  return `${required}|${optional}|${keyText}`;
}

function normalizeKeyToken(key: string): string {
  return decodeChordKeyToken(key).toUpperCase();
}
