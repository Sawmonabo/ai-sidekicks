// The key a window's place is kept under, read off the frame name the hidden console document's
// `window.open` carries, which is the window's id (`@shared/window/frame-name.ts`). A window of
// session views keeps its place under its own id; a pane in a window of its own,
// `pane/<pane kind>/<session id>`, keeps it per pane kind, so the next pane of that kind opens
// where the last one was. Any other name is not a window main builds.

import { FRAME_NAME_IDENTIFIER, isConsoleWindowId } from "@shared/window/frame-name.js";

const PANE_WINDOW_ID = new RegExp(`^pane/(${FRAME_NAME_IDENTIFIER})/${FRAME_NAME_IDENTIFIER}$`);

const PANE_PLACE_KEY_PREFIX = "pane/";

/** The key a window's place is kept under; `undefined` for a name main builds no window for. */
export function placeKeyForFrameName(frameName: string): string | undefined {
  if (isConsoleWindowId(frameName)) {
    return frameName;
  }
  const paneWindow = PANE_WINDOW_ID.exec(frameName);
  if (paneWindow !== null) {
    return `${PANE_PLACE_KEY_PREFIX}${paneWindow[1] ?? ""}`;
  }
  return undefined;
}

/** The pane kind a pane window's place key names; `undefined` for a console window's. */
export function paneKindOfPlaceKey(placeKey: string): string | undefined {
  return placeKey.startsWith(PANE_PLACE_KEY_PREFIX)
    ? placeKey.slice(PANE_PLACE_KEY_PREFIX.length)
    : undefined;
}
