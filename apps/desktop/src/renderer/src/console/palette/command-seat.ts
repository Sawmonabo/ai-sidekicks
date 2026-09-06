// How a SURFACE contributes commands for as long as it is on screen.
//
// The frame's own commands are registered from an effect and removed on unmount
// (`frame/frame-commands.ts`), and a view family's are the same shape for the same
// reason: they close over a live store, a live bridge, and the rows a pane is
// currently showing, none of which exists at module scope. What a family must not
// copy from the frame is the mechanism — two hand-written register/unregister
// effects against one module-scoped registry is two places to get the unregister
// wrong — so the lifecycle lands here once and every surface takes it as a hook.
//
// IT CONTRIBUTES THROUGH THE SEAT AND NOT THROUGH `registerConsoleCommands`, and
// that is the whole point rather than a preference. The palette re-reads the
// registry once per `commandRevision`, and the only thing that moves the revision
// is a contribution signal: a surface that called `registerConsoleCommands`
// directly would add its rows to a registry the open palette has already memoised
// against, and the commands would be invisible until something unrelated bumped
// it. The frame gets away with the plural call because it bumps the revision
// itself, in the same effect; a pane has no revision to bump.
//
// ONE LIVE CONTRIBUTOR PER OWNER, TRACKED BY TOKEN. `contribute` is owner-scoped
// replace, which is exactly right for a surface re-contributing its own changed
// rows and exactly wrong for two mounts of one surface: the second replaces the
// first, and then the FIRST one's unmount clears rows the second still owns,
// leaving a live pane whose commands are gone from the palette with nothing on
// screen to say so. So each contribution records the token that made it, and a
// cleanup clears the owner only while its own token is still the live one. A
// stale mount's teardown is a no-op, which is the same rule `GenerationLatch`
// applies to a settlement arriving on a transport that has been replaced.
//
// NO CHORDS. The seat contributes acts and binds no keys: a chord is a
// window-wide claim, the key-binding table refuses two bindings on one chord, and
// a pane that bound one would be racing every other pane in the deck for it. The
// keyboard path to these acts is the palette itself, which is one chord for all
// of them.

import { useEffect } from "react";

import { consoleCommandSurface } from "./console-commands.js";
import type { ConsoleCommand } from "./contributions.js";

/** No chords, always. Frozen so a caller cannot make this the exception. */
const NO_KEY_BINDINGS: readonly [] = Object.freeze([]);

/** The token whose contribution is live, per owner. */
const liveTokenByOwner = new Map<string, symbol>();

/**
 * Contribute `commands` under `owner` for as long as this component is mounted.
 *
 * `commands` MUST BE REFERENTIALLY STABLE while its contents are unchanged: the
 * effect re-contributes whenever the list's identity changes, and a list rebuilt
 * per render would re-register the owner's rows — and bump the palette's revision
 * — on every keystroke and every streamed run event. Callers memoise on a
 * signature of what the rows SAY and read everything that moves underneath them
 * through a ref, so a run version advancing does not rewrite the palette.
 */
export function useConsoleCommandSeat(owner: string, commands: readonly ConsoleCommand[]): void {
  useEffect(() => {
    const token = Symbol(owner);
    liveTokenByOwner.set(owner, token);
    consoleCommandSurface.contribute({ owner, commands, keyBindings: NO_KEY_BINDINGS });
    return () => {
      // Only the live contributor clears the owner. A mount React has already
      // replaced — a second pane of this kind, a development-mode remount — tears
      // down after the one that superseded it, and clearing there would take a
      // living surface's commands out of the palette.
      if (liveTokenByOwner.get(owner) !== token) {
        return;
      }
      liveTokenByOwner.delete(owner);
      consoleCommandSurface.contribute({ owner, commands: [], keyBindings: NO_KEY_BINDINGS });
    };
  }, [owner, commands]);
}
