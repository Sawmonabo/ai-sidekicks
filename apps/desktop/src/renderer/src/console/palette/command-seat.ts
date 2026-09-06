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
// ONE LIVE CONTRIBUTOR PER OWNER, AND THE SURFACE KEEPS THAT — NOT THIS HOOK. Two
// mounts of one surface would otherwise tear down in the wrong order and the first
// one's cleanup would clear rows the second still owns. The token that decides
// which contributor is live belongs beside the owner-scoped replace it disambiguates,
// so `contribute` hands back a release that is a no-op once superseded and this hook
// returns it as its effect cleanup. What that buys beyond tidiness is instance
// scoping: a token map at module scope is shared by every composition in the process
// — a second window, a second test mount building its own registry — and one of them
// superseding an owner it has no rows in silently disarms the other's release.
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
  useEffect(
    // The release IS the cleanup. Only the live contributor clears the owner: a mount
    // React has already replaced — a second pane of this kind, a development-mode
    // remount — tears down after the one that superseded it, and the release it holds
    // is already a no-op by then.
    () => consoleCommandSurface.contribute({ owner, commands, keyBindings: NO_KEY_BINDINGS }),
    [owner, commands],
  );
}
