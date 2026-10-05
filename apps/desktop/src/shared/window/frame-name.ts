// A window's id is the frame name the hidden console document opens it under with `window.open`;
// main reads the name back to build the window and find it again, and the renderer keys the
// window's kept layout by it. A window of session views is `window/<key>`; a pane in a window of
// its own is `pane/<pane kind>/<session id>`. Both sides compose and parse the console window's
// name here.

/** The identifier characters every part of a frame name is drawn from. */
export const FRAME_NAME_IDENTIFIER = "[A-Za-z0-9_-]{1,128}";

const CONSOLE_WINDOW_ID = new RegExp(`^window/${FRAME_NAME_IDENTIFIER}$`);

/** The id of a new window of session views, from a fresh `key` (a UUID). */
export function consoleWindowId(key: string): string {
  return `window/${key}`;
}

/** Whether `value` is the id of a window of session views. */
export function isConsoleWindowId(value: unknown): value is string {
  return typeof value === "string" && CONSOLE_WINDOW_ID.test(value);
}
