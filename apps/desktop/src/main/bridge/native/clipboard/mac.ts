// The macOS clipboard. A text flavor read by its MIME type, or the plain text read as text, is
// converted on main's thread, which takes tens of milliseconds for a few mebibytes; the same flavor
// read under the pasteboard's own type comes back as its bytes as held, the same UTF-8, in a few
// milliseconds, and its plain text is decoded from them a chunk at a time.

import { setImmediate as nextTask } from "node:timers/promises";

import {
  clipboardHostOver,
  MAIN_TASK_CHUNK,
  rawClipboardFormat,
  type ClipboardHost,
} from "./host.js";

/** The pasteboard's own type of each text flavor, as Electron names it. */
const PASTEBOARD_TYPE_OF_FLAVOR: ReadonlyMap<string, string> = new Map([
  ["text/plain", rawClipboardFormat("NSStringPboardType")],
  ["text/html", rawClipboardFormat("Apple HTML pasteboard type")],
]);

/**
 * `electronClipboard` as macOS keeps it: a held text flavor read under the pasteboard's own type
 * where the entry lists it, and by its MIME type where it does not; the plain text decoded from
 * that read of the first entry's, empty when it holds none; and a picture held as PNG alone, which
 * a reader asking for another picture type is given converted by the system.
 */
export function macClipboardHost(electronClipboard: Electron.Clipboard): ClipboardHost {
  const readHeldText = async (item: Electron.ClipboardItem, type: string): Promise<Blob> => {
    const pasteboardType = PASTEBOARD_TYPE_OF_FLAVOR.get(type);
    // Electron refuses a type the entry does not list, so the twin is read only where it is held.
    const readType =
      pasteboardType !== undefined && item.types.includes(pasteboardType) ? pasteboardType : type;
    return (await item.getType(readType)) as Blob;
  };
  return clipboardHostOver(electronClipboard, {
    readHeldText,
    readText: async () => {
      const [item] = await electronClipboard.read();
      return item === undefined || !item.types.includes("text/plain")
        ? ""
        : await decodedInChunks(await readHeldText(item, "text/plain"));
    },
    pictureFormat: "public.png",
  });
}

/** `bytes` decoded as UTF-8, a chunk in each task, a character cut by a chunk's end kept whole. */
async function decodedInChunks(bytes: Blob): Promise<string> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  for (let start = 0; start < bytes.size; start += MAIN_TASK_CHUNK) {
    if (start > 0) {
      await nextTask();
    }
    const chunk = await bytes.slice(start, start + MAIN_TASK_CHUNK).arrayBuffer();
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}
