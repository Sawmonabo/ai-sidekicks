// The id of the window whose document holds the bridge, as it crosses from main into that window.
//
// Main builds the console window used last under its kept window id, minting one on a first
// launch, and passes the id as a renderer switch through `webPreferences.additionalArguments`.
// The sandboxed preload reads it off its own `process.argv` and exposes it as `window.id`, the key
// the renderer's kept layout files that window under. Both spellings of the switch live here once.

import { readRequiredSwitchValue } from "../renderer-switch.js";

const WINDOW_ID_SWITCH = "--sidekicks-window-id=";

/** The renderer switch that carries `windowId` into the window; the value is URI-encoded. */
export function windowIdSwitch(windowId: string): string {
  return `${WINDOW_ID_SWITCH}${encodeURIComponent(windowId)}`;
}

/**
 * The window id a window's switches carry. Throws when it is missing: main passes it to every
 * window that loads the renderer.
 */
export function readWindowIdSwitch(argv: readonly string[]): string {
  return readRequiredSwitchValue(argv, WINDOW_ID_SWITCH);
}
