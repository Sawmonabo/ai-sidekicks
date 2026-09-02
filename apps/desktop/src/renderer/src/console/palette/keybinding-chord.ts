// The chord — one keystroke, parsed, matched, and compared.
//
// WHAT IS ADOPTED AND WHAT IS OURS. `Spec-023 §Console Libraries`, the headless
// UI row: "ADOPT `tinykeys` 4.0.0 as the chord parser only … OWN-BUILD the
// keybinding service and when-clause grammar". This module is the whole of the
// adopted half: it imports exactly two things from tinykeys — `parseKeybinding`,
// which turns `"$mod+KeyK"` into modifier sets and a key, and
// `matchKeybindingPress`, which decides whether one `KeyboardEvent` satisfies one
// parsed press — and wraps them in the two refusals and the one comparison key the
// service above needs. It deliberately does NOT call `tinykeys()` itself; the
// three reasons are stated in `keybindings.ts`, which is the module that would
// otherwise have used it.
//
// WHAT IS NOT HERE. How a chord is PRINTED and SPOKEN lives in
// `primitives/chord-format.ts`. A keycap is a renderer's concern and primitives
// are below palette in the console's import graph, so keeping the tables here
// forced `ChordHint` to reach up into this family for its vocabulary. The one
// symbol that has to be shared is imported below, and it is shared rather than
// duplicated because the printer and the conflict comparator disagreeing about
// whether `k` and `KeyK` are one keystroke is the exact defect it prevents.

import { matchKeybindingPress, parseKeybinding, type KeybindingPress } from "tinykeys";
import { decodeChordKeyToken } from "../primitives/index.js";

/** Why a chord string was refused. */
export type ChordParseErrorKind = "empty-chord" | "sequence-unsupported" | "no-key";

/** A chord that parsed, or the reason it did not. */
export type ChordParseResult =
  | { readonly ok: true; readonly press: KeybindingPress }
  | { readonly ok: false; readonly kind: ChordParseErrorKind; readonly message: string };

/**
 * Parse a chord into the single press the table matches against.
 *
 * MULTI-PRESS SEQUENCES ARE REFUSED. tinykeys can express `"g d"`, and honouring
 * it would require a pending-press map behind a timeout — a timer on the
 * console's input path, which `Spec-023 §Console Design (Meridian)` §The four
 * bars rules out ("no timer fires except the refresh scheduler's deadline and the
 * presence heartbeat"). The grammar that spec names is a CHORD grammar, so a
 * sequence is refused loudly at install rather than half-supported at runtime.
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
      message: `"${trimmed}" is a multi-press sequence; the console binds single chords only`,
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

/** Does this event satisfy this parsed chord? Thin, so tinykeys owns the semantics. */
export function chordMatchesEvent(press: KeybindingPress, event: KeyboardEvent): boolean {
  return matchKeybindingPress(event, press);
}

/**
 * A comparison key for a parsed press: required modifiers, optional modifiers,
 * and the key, each normalised so two spellings of one keystroke collide. A
 * regular-expression key is compared by its source, which is exact for the
 * spellings tinykeys produces.
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
