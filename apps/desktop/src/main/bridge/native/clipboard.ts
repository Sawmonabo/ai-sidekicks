// The system clipboard, written by main for the page: a plain line, or the text with a formatted
// flavor beside it, in one write, so a paste target picks the flavor it understands.

import { z } from "zod";

/** Each flavor one copy writes, by its MIME type. */
export interface ClipboardFlavors {
  readonly "text/plain": string;
  readonly "text/html"?: string;
}

/** Writes one clipboard entry: Electron's `clipboard.write` with one `ClipboardItem`. */
export interface ClipboardHost {
  write(flavors: ClipboardFlavors): Promise<void>;
}

const clipboardContentSchema = z.object({ text: z.string(), html: z.string().optional() });

/**
 * Put the page's content on the system clipboard in one write. Throws a `ZodError` for anything
 * but `{text}` or `{text, html}` with string values, before the clipboard is touched.
 */
export async function copyToClipboard(host: ClipboardHost, content: unknown): Promise<void> {
  const { text, html } = clipboardContentSchema.parse(content);
  await host.write(
    html === undefined ? { "text/plain": text } : { "text/plain": text, "text/html": html },
  );
}
