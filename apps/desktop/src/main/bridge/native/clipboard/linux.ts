// The Linux clipboards: their text read as Electron reads it, and a picture's PNG bytes offered
// under the `image/png` target.

import { clipboardHostOver, electronTextReading, type ClipboardHost } from "./host.js";

/** `electronClipboard` as Linux keeps it, the selection one included. */
export function linuxClipboardHost(electronClipboard: Electron.Clipboard): ClipboardHost {
  return clipboardHostOver(electronClipboard, {
    ...electronTextReading(electronClipboard),
    pictureFormat: "image/png",
  });
}
