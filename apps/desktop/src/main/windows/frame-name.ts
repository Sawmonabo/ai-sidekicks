// The frame name the renderer's `window.open` carries, read as the place a window is kept under.
// A console window is `window/<window id>`, the id the renderer's kept layout shares; a pane in a
// window of its own is `pane/<pane kind>/<session id>`, kept per pane kind, so the next pane of
// that kind opens where the last one was. Any other name is not a window main builds.

const IDENTIFIER = "[A-Za-z0-9_-]{1,128}";
const WINDOW_ID = new RegExp(`^${IDENTIFIER}$`);
const CONSOLE_WINDOW_FRAME = new RegExp(`^window/(${IDENTIFIER})$`);
const PANE_WINDOW_FRAME = new RegExp(`^pane/(${IDENTIFIER})/${IDENTIFIER}$`);

/** The key a window's place is kept under; `undefined` for a name main builds no window for. */
export function placeKeyForFrameName(frameName: string): string | undefined {
  const consoleWindow = CONSOLE_WINDOW_FRAME.exec(frameName);
  if (consoleWindow !== null) {
    return consoleWindowPlaceKey(consoleWindow[1] ?? "");
  }
  const paneWindow = PANE_WINDOW_FRAME.exec(frameName);
  if (paneWindow !== null) {
    return `pane/${paneWindow[1] ?? ""}`;
  }
  return undefined;
}

/** The key the place of the console window with `windowId` is kept under. */
export function consoleWindowPlaceKey(windowId: string): string {
  return `window/${windowId}`;
}

/** The window id a console window's place key carries; `undefined` for a pane's own window. */
export function windowIdOfPlaceKey(placeKey: string): string | undefined {
  return CONSOLE_WINDOW_FRAME.exec(placeKey)?.[1];
}

/** Whether `value` is a window id the frame-name grammar accepts. */
export function isWindowId(value: unknown): value is string {
  return typeof value === "string" && WINDOW_ID.test(value);
}
