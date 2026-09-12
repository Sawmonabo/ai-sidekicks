// The chords the menu bar's auxiliary entries take, declared where both processes
// can read them.
//
// WHY THIS MOVED OUT OF THE MENU. It was a `Record` inside `src/main/menu.ts` whose
// own comment argued for keeping it there — "an accelerator is meaningless to the
// renderer bundle" — and that argument is false in the one direction that matters. A
// menu accelerator is consumed by Electron BEFORE the renderer's key-binding table
// sees the keystroke, so a chord the menu owns is a chord no renderer binding can
// ever run. `palette/keybindings/keybinding-audit.ts` said as much and then declined to check it,
// for a reason that was true while this table was main-private: "those live in the
// main process, the renderer has no read for them, and a guessed list would be wrong
// in exactly the direction that matters — telling somebody a chord is free when the
// menu bar will take it." This module is that read, so the guess is not needed and
// the collision is a gate rather than a review.
//
// It found one immediately: `CmdOrCtrl+Shift+T` here against `$mod+Shift+t` on
// `ledger.scrollToTail`. See {@link AUXILIARY_MENU_CHORDS} for which side moved.
//
// DECLARED IN THE CONSOLE'S CHORD GRAMMAR, NOT ELECTRON'S, and that direction is the
// whole point of one home: the renderer's parser is the console's single reader of a
// chord string, and it cannot be asked to learn a second grammar. The menu is the
// one caller that needs Electron's spelling, and it gets it from
// {@link electronAcceleratorFor} — a conversion, not a second table.
//
// This module may import nothing but `@ai-sidekicks/contracts` — it is compiled into
// the RENDERER bundle, so `electron`, `node:*`, and the main/preload subtrees are
// forbidden here (`apps/desktop/eslint.config.mjs`). It holds data and pure
// functions: no state, no I/O.

import { type AuxiliaryRouteName } from "./auxiliary-routes.js";

/**
 * The chord each auxiliary route's menu entry carries, in `tinykeys` grammar.
 *
 * A TOTAL `Record` over the closed route set — over the ROUTE set and not over the
 * bare-launchable subset, so adding a route is a compile error here until its chord
 * is decided even while its entry is not yet offered. That is the same forcing
 * function the shared label record and the window factory's geometry record apply at
 * the other two sites a new route needs a decision.
 *
 * THE TIMELINE ENTRY MOVED OFF `T`, AND THE MENU IS THE SIDE THAT MOVED. It held
 * `CmdOrCtrl+Shift+T`, which is `$mod+Shift+t` — the chord `ledger.scrollToTail` has
 * been contributed on since the ledger's commands were written. Three things decided
 * it against the menu. The renderer binding is LIVE and reachable in every session,
 * while `BARE_LAUNCHABLE_AUXILIARY_ROUTES` is empty, so the menu entry this
 * accelerator belongs to renders nowhere and nobody has ever pressed it. Electron
 * takes a menu accelerator ahead of the renderer, so shipping both would have made
 * scroll-to-tail stop working the day that entry appeared, with the keyboard page
 * still reporting the binding as installed. And scroll-to-tail is a named Timeline
 * View interaction, while nothing anywhere names this entry's shortcut — so moving
 * the menu costs no stated contract, and moving the ledger would strand every
 * override a person has already recorded against its chord.
 *
 * `L` because `T` is spent: it is the next letter of the route's own label that no
 * table claims, on any platform. It differs from the composer chord in
 * `./composer-chord.ts` by `Shift`, which the audit compares exactly — the ledger
 * already ships `$mod+g` beside `$mod+Shift+g` on the same terms.
 */
export const AUXILIARY_MENU_CHORDS: Record<AuxiliaryRouteName, string> = {
  timeline: "$mod+Shift+KeyL",
  "agent-console": "$mod+Shift+KeyA",
};

/** Every chord the menu bar takes before the renderer can see the keystroke. */
export const AUXILIARY_MENU_CHORD_LIST: readonly string[] = Object.values(AUXILIARY_MENU_CHORDS);

/**
 * Raised when a chord cannot be rendered as an Electron accelerator.
 *
 * A named class rather than a bare `Error` so the menu's own failure is
 * distinguishable from Electron refusing an accelerator it was handed, and so the
 * message can name the token rather than the whole chord.
 */
export class UnrenderableAcceleratorError extends Error {
  public constructor(reason: string) {
    super(`chord cannot be rendered as a menu accelerator: ${reason}`);
    this.name = "UnrenderableAcceleratorError";
  }
}

/**
 * The modifier tokens this conversion admits, in the console's spelling, mapped to
 * Electron's.
 *
 * A closed table rather than a pass-through: a modifier Electron does not know is
 * accepted silently by `Menu.buildFromTemplate` and produces an entry with no
 * working shortcut, which is the failure mode this whole module exists to make
 * visible.
 */
const ELECTRON_MODIFIERS: Readonly<Record<string, string>> = {
  $mod: "CmdOrCtrl",
  Shift: "Shift",
  Alt: "Alt",
  Control: "Control",
};

/** `KeyX` and `DigitN`, the two key spellings the console's chords use. */
const KEY_CODE_TOKEN = /^Key([A-Z])$/;
const DIGIT_CODE_TOKEN = /^Digit([0-9])$/;

/**
 * `chord` as an Electron accelerator string.
 *
 * Total over what {@link AUXILIARY_MENU_CHORDS} declares and refusing everything
 * else, loudly: a chord that reaches Electron in a shape it does not parse renders a
 * menu entry whose shortcut silently does nothing, and this is the only place that
 * can tell the difference.
 */
export function electronAcceleratorFor(chord: string): string {
  const tokens = chord.split("+");
  const keyToken = tokens[tokens.length - 1];
  if (keyToken === undefined || tokens.length < 2) {
    throw new UnrenderableAcceleratorError("a chord is at least one modifier and one key");
  }
  const modifiers = tokens.slice(0, -1).map((token) => {
    const electronModifier = ELECTRON_MODIFIERS[token];
    if (electronModifier === undefined) {
      throw new UnrenderableAcceleratorError(`unknown modifier "${token}"`);
    }
    return electronModifier;
  });
  const key = KEY_CODE_TOKEN.exec(keyToken)?.[1] ?? DIGIT_CODE_TOKEN.exec(keyToken)?.[1];
  if (key === undefined) {
    throw new UnrenderableAcceleratorError(`unknown key "${keyToken}"`);
  }
  return [...modifiers, key].join("+");
}
