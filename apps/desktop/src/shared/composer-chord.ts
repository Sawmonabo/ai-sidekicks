// The composer-focus chord and the modifier its `$mod` names.
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
 * spelling `primitives/chord/chord-format.ts` prefers for the same reason: a code names
 * one physical key on every keyboard layout, while a printed character names a
 * different key on each. The console's chord matcher treats the two spellings as one
 * keystroke, so a renderer binding either of them binds this.
 *
 * `$mod` is the platform's primary modifier — command on macOS, control elsewhere.
 * The pair is free in the console's key-binding table (the ledger holds `$mod+f`,
 * `$mod+g`, `$mod+Shift+g` and `$mod+Shift+t`; the frame holds `$mod+1`, `$mod+2`
 * and `$mod+,`) and is none of the chords `palette/keybindings/keybinding-audit.ts` records as
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
 * Which modifier `$mod` is on `platform`.
 *
 * Takes the platform string rather than reading one: this module is compiled into a
 * sandboxed renderer that has no `process`. The value is Node's, so `"darwin"` is the
 * whole of the macOS arm — there is no second spelling to accept.
 */
export function composerChordPrimaryModifier(platform: string): ComposerChordPrimaryModifier {
  return platform === "darwin" ? "meta" : "control";
}
