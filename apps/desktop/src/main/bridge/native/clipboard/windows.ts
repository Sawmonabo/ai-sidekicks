// The Windows clipboard: its text read as Electron reads it, and a picture's PNG bytes held under
// the "PNG" format Windows apps register for them.

import { clipboardHostOver, electronTextReading, type ClipboardHost } from "./host.js";

/** `electronClipboard` as Windows keeps it. */
export function windowsClipboardHost(electronClipboard: Electron.Clipboard): ClipboardHost {
  return clipboardHostOver(electronClipboard, {
    ...electronTextReading(electronClipboard),
    pictureFormat: "PNG",
  });
}
