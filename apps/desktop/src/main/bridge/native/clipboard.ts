// The system clipboard, written by main for the page: a plain line, the text with a formatted
// flavor beside it, or a PNG picture, in one write, so a paste target picks the flavor it
// understands.

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

/**
 * Put the page's content on the system clipboard in one write. Throws a `ZodError` for anything
 * but `{text}`, `{text, html}` with string values, or `{png}` holding a PNG file's bytes, before
 * the clipboard is touched.
 */
export async function copyToClipboard(host: ClipboardHost, content: unknown): Promise<void> {
  const parsed = clipboardContentSchema.parse(content);
  if ("png" in parsed) {
    await host.write({ "image/png": new Blob([parsed.png], { type: "image/png" }) });
    return;
  }
  const { text, html } = parsed;
  await host.write(
    html === undefined ? { "text/plain": text } : { "text/plain": text, "text/html": html },
  );
}
