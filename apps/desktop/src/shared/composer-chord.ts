// The composer-focus chord, declared once for both processes.
//
// SHARED, and for the reason `./auxiliary-routes.ts` states about its own grammar:
// this chord has two readers in two processes and no channel between them. The
// renderer's key-binding table binds it to the act that puts the caret in the
// composer; the main process WATCHES for it in an auxiliary window, which has no
// composer to put a caret in (`Spec-023 §Console Design (Meridian)` §The surface
// set — a detached timeline "shows the same pane at full width … and no composer").
// Written twice, the two readers drift, and the drift is silent: the auxiliary
// window would answer a keystroke the main window binds to something else, or
// answer none at all while the person keeps pressing.
//
// WHY MAIN WATCHES AT ALL. An auxiliary window is its own renderer process with its
// own bridge instance and no store shared with the main window, so nothing in it can
// reach the main window's composer. Only the process that owns both windows can act
// on the press, and it owns exactly one half of the act — bringing the composer's
// window forward. The other half, moving the caret, belongs to the window that has
// the composer and lands with the family that draws one; both halves read this
// declaration, which is what makes them one chord rather than two.
//
// This module may import nothing but `@ai-sidekicks/contracts` — it is compiled into
// the RENDERER bundle, so `electron`, `node:*`, and the main/preload subtrees are
// forbidden here (`apps/desktop/eslint.config.mjs`). It holds data and pure
// functions: no state, no I/O, and no platform READ — the platform arrives as an
// argument, because a sandboxed renderer has no `process` to read one from.

/**
 * The chord, in `tinykeys` grammar, that asks for the composer.
 *
 * Spelled with the physical `KeyL` code rather than the printed `l`, which is the
 * spelling `primitives/chord-format.ts` prefers for the same reason: a code names
 * one physical key on every keyboard layout, while a printed character names a
 * different key on each. The console's chord matcher treats the two spellings as one
 * keystroke, so a renderer binding either of them binds this.
 *
 * `$mod` is the platform's primary modifier — command on macOS, control elsewhere.
 * The pair is free in the console's key-binding table (the ledger holds `$mod+f`,
 * `$mod+g`, `$mod+Shift+g` and `$mod+Shift+t`; the frame holds `$mod+1`, `$mod+2`
 * and `$mod+,`) and is none of the chords `palette/keybinding-audit.ts` records as
 * claimed by an operating system.
 */
export const COMPOSER_FOCUS_CHORD = "$mod+KeyL";

/**
 * Which physical modifier `$mod` names on a host.
 *
 * Two members and not a boolean: the value is read into a sentence and into a
 * comparison, and `usesMeta: false` names the modifier it is not.
 */
export type ComposerChordPrimaryModifier = "meta" | "control";

/**
 * The keystroke members {@link matchesComposerFocusChord} reads.
 *
 * A structural shape rather than Electron's `Input`, so this module stays free of
 * the main-process type surface it is forbidden to import — and so the renderer's
 * own `KeyboardEvent` satisfies it unchanged when the composer family binds the
 * same chord. Every member is required: an absent modifier flag read as `false`
 * would make a chord match a keystroke that carried the modifier.
 */
export interface ComposerChordKeystroke {
  /** The physical key, as `KeyboardEvent.code` spells it (`"KeyL"`). */
  readonly code: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** The physical key `COMPOSER_FOCUS_CHORD` names, split out of the chord once. */
const COMPOSER_FOCUS_KEY_CODE = "KeyL";

/**
 * Which modifier `$mod` is on `platform`.
 *
 * Takes the platform string rather than reading one: this module is compiled into a
 * sandboxed renderer that has no `process`, and the one caller that does have one
 * passes `process.platform`. The value is Node's, so `"darwin"` is the whole of the
 * macOS arm — there is no second spelling to accept.
 */
export function composerChordPrimaryModifier(platform: string): ComposerChordPrimaryModifier {
  return platform === "darwin" ? "meta" : "control";
}

/**
 * Whether `keystroke` is the composer chord on a host whose `$mod` is
 * `primaryModifier`.
 *
 * EXACT ON EVERY MODIFIER, not merely on the primary one. A match that ignored the
 * others would answer command-option-L and command-shift-L as well, which are
 * chords a person may have bound to something else entirely — and the window this
 * runs in cannot see what the main window bound, so a loose match here silently
 * takes a keystroke away from a binding it cannot name.
 *
 * The non-primary modifier is required to be ABSENT rather than left unread: on
 * macOS a control-L that also carried command would otherwise match twice over.
 */
export function matchesComposerFocusChord(
  keystroke: ComposerChordKeystroke,
  primaryModifier: ComposerChordPrimaryModifier,
): boolean {
  if (keystroke.code !== COMPOSER_FOCUS_KEY_CODE || keystroke.alt || keystroke.shift) {
    return false;
  }
  return primaryModifier === "meta"
    ? keystroke.meta && !keystroke.control
    : keystroke.control && !keystroke.meta;
}
