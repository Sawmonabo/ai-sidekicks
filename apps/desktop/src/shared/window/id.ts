// The window used last at the last quit, as it crosses from main into the hidden console document.
//
// Main mints a window id on a first launch and otherwise keeps the one used last, and passes it to
// the hidden console window as a renderer switch through `webPreferences.additionalArguments`. The
// sandboxed preload reads it off its own `process.argv` and exposes it as
// `window.lastUsedWindowId`, the window the console document opens first. Every window's own id
// rides its frame name instead (`./frame-name.ts`). Both spellings of the switch live here once.

import { readRequiredSwitchValue } from "../renderer-switch.js";

const LAST_USED_WINDOW_ID_SWITCH = "--sidekicks-last-used-window-id=";

/** The renderer switch that carries the window used last; the value is URI-encoded. */
export function lastUsedWindowIdSwitch(windowId: string): string {
  return `${LAST_USED_WINDOW_ID_SWITCH}${encodeURIComponent(windowId)}`;
}

/**
 * The window used last that the console window's switches carry. Throws when it is missing: main
 * passes it to every console window it builds.
 */
export function readLastUsedWindowIdSwitch(argv: readonly string[]): string {
  return readRequiredSwitchValue(argv, LAST_USED_WINDOW_ID_SWITCH);
}
