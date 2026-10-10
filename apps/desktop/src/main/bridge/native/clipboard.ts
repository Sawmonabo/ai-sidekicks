// A clipboard, written by main for the page: a plain line, the text with a formatted flavor beside
// it, or a PNG picture, in one write, so a paste target picks the flavor it understands. The page
// names the system clipboard or Linux's selection one, which a middle-click pastes. Which
// clipboards a system keeps is chosen once, from its platform.

import { ClipboardItem } from "electron";
import * as z from "zod/mini";

/** Each flavor one copy writes, by its MIME type: text with its formatting, or a picture. */
export type ClipboardFlavors =
  | { readonly "text/plain": string; readonly "text/html"?: string }
  | { readonly "image/png": Blob };

/** Writes one clipboard entry: Electron's `clipboard.write` with one `ClipboardItem`. */
export interface ClipboardHost {
  write(flavors: ClipboardFlavors): Promise<void>;
}

/** The eight bytes every PNG file opens with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The clipboards a copy may name: the system's, and the selection one only Linux keeps. */
export interface ClipboardHosts {
  readonly system: ClipboardHost;
  readonly selection: ClipboardHost | undefined;
}

/**
 * This operating system's clipboards over Electron's: the system one everywhere, and the selection
 * one on Linux alone, the one system that keeps it.
 */
export function clipboardHostsFor(
  platform: NodeJS.Platform,
  electronClipboard: Electron.Clipboard,
): ClipboardHosts {
  return {
    system: clipboardHostOf(electronClipboard),
    selection: platform === "linux" ? clipboardHostOf(electronClipboard.selection) : undefined,
  };
}

const clipboardContentSchema = z.union([
  z.strictObject({
    text: z.string(),
    html: z.optional(z.string()),
  }),
  z.strictObject({
    png: z.instanceof(Uint8Array).check(
      z.refine((bytes) => PNG_SIGNATURE.every((byte, index) => bytes[index] === byte), {
        message: "The picture is not a PNG.",
      }),
    ),
  }),
]);

const copyRequestSchema = z.strictObject({
  content: clipboardContentSchema,
  clipboard: z.optional(z.literal("selection")),
});

/**
 * Put the page's content on the clipboard it names in one write. Throws a `ZodError` for content
 * but `{text}`, `{text, html}` with string values, or `{png}` holding a PNG file's bytes, or a
 * clipboard but `"selection"`, and an `Error` for the selection one where the system keeps none,
 * before any clipboard is touched.
 */
export async function copyToClipboard(clipboards: ClipboardHosts, request: unknown): Promise<void> {
  const { content: parsed, clipboard } = copyRequestSchema.parse(request);
  const host = clipboard === undefined ? clipboards.system : clipboards.selection;
  if (host === undefined) {
    throw new Error("This system keeps no selection clipboard.");
  }
  if ("png" in parsed) {
    await host.write({ "image/png": new Blob([parsed.png], { type: "image/png" }) });
    return;
  }
  const { text, html } = parsed;
  await host.write(
    html === undefined ? { "text/plain": text } : { "text/plain": text, "text/html": html },
  );
}

function clipboardHostOf(electronClipboard: Electron.Clipboard): ClipboardHost {
  return { write: (flavors) => electronClipboard.write([new ClipboardItem({ ...flavors })]) };
}
