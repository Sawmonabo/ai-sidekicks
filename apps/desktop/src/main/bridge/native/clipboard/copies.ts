// The page's copies, written by main: a plain line, the text with a formatted flavor beside it, or
// a PNG picture, in one write, so a paste target picks the flavor it understands. The page names
// the system clipboard or Linux's selection one, which a middle-click pastes. A copy whose content
// comes after it was asked for, and every picture, sends its text and formatted flavor or its
// picture's bytes in pieces first, which main holds for one copy at a time and joins for the write;
// it writes only while the clipboard holds what it held then, and its formatted flavor, coming
// after its text, joins it only while the system clipboard still holds that text, so a newer copy
// stands. Main's thread routes every window's input, so work that grows with a copy (joining its
// pieces, reading what the clipboard holds, comparing it) runs a bounded chunk at a time, other
// tasks let in between; Electron's own read and write calls are one step each.

import { createHash } from "node:crypto";
import { setImmediate as nextTask } from "node:timers/promises";

import * as z from "zod/mini";

import type { ClipboardPieces, HeldClipboardCopy } from "#shared/clipboard-pieces.js";
import type { ClipboardSnapshot } from "#shared/preload-api.js";
import {
  MAIN_TASK_CHUNK,
  type ClipboardFlavors,
  type ClipboardHost,
  type ClipboardHosts,
} from "./host.js";

/** The eight bytes every PNG file opens with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const copyNamingSchema = z.strictObject({ copyId: z.string() });

const clipboardContentSchema = z.strictObject({
  text: z.string(),
  html: z.optional(z.string()),
});

const pieceIndexSchema = z.int().check(z.minimum(0));

const clipboardPieceSchema = z.union([
  z.strictObject({
    copyId: z.string(),
    flavor: z.enum(["text", "html"]),
    index: pieceIndexSchema,
    piece: z.string(),
  }),
  z.strictObject({
    copyId: z.string(),
    flavor: z.literal("png"),
    index: pieceIndexSchema,
    // A `Uint8Array` arrives over IPC on its own `ArrayBuffer`, never a shared one.
    piece: z.instanceof(Uint8Array<ArrayBuffer>),
  }),
]);

const clipboardNameSchema = z.optional(z.literal("selection"));

const copyRequestSchema = z.strictObject({
  content: clipboardContentSchema,
  clipboard: clipboardNameSchema,
});

const snapshotRequestSchema = z.strictObject({ clipboard: clipboardNameSchema });

const unlessChangedRequestSchema = z.strictObject({
  copyId: z.string(),
  since: z.strictObject({ clipboard: clipboardNameSchema, digest: z.string() }),
});

/**
 * Holds one piece of a late copy in `pieces`. Throws a `ZodError` for a request but a
 * `ClipboardPiece`, and an `Error` for a piece naming a copy not held or one out of order.
 */
export function takeClipboardPiece(pieces: ClipboardPieces, request: unknown): void {
  pieces.take(clipboardPieceSchema.parse(request));
}

/**
 * Lets the copy a `{copyId}` request names go from `pieces`, when it is the one held. Throws a
 * `ZodError` for a request but `{copyId}`.
 */
export function dropClipboardPieces(pieces: ClipboardPieces, request: unknown): void {
  pieces.drop(copyNamingSchema.parse(request).copyId);
}

/**
 * Put the page's text on the clipboard it names in one write. Throws a `ZodError` for content but
 * `{text}` or `{text, html}` with string values, or a clipboard but `"selection"`, and an `Error`
 * for the selection one where the system keeps none, before any clipboard is touched.
 */
export async function copyToClipboard(clipboards: ClipboardHosts, request: unknown): Promise<void> {
  const { content, clipboard } = copyRequestSchema.parse(request);
  const { text, html } = content;
  await hostNamed(clipboards, clipboard).write(
    html === undefined ? { "text/plain": text } : { "text/plain": text, "text/html": html },
  );
}

/**
 * What the clipboard the page names holds now, as the digest a later write compares against: each
 * entry's flavor types and its text flavors. Throws as `copyToClipboard` does for the clipboard.
 */
export async function takeClipboardSnapshot(
  clipboards: ClipboardHosts,
  request: unknown,
): Promise<ClipboardSnapshot> {
  const { clipboard } = snapshotRequestSchema.parse(request);
  // An app copying between the key press and this read is taken as what was held, and replaced.
  const digest = await heldDigestOf(hostNamed(clipboards, clipboard));
  return clipboard === undefined ? { digest } : { clipboard, digest };
}

/**
 * Put a late copy on the clipboard its snapshot names, in one write, only while that clipboard
 * still holds what it held when the snapshot was taken: `false`, writing nothing, once a newer
 * copy holds it, or once the copy's pieces were let go before it was written, as when a newer
 * copy's first piece arrived. Its text and formatted flavor, or its picture, come from the pieces
 * `pieces` holds for it, text joined a chunk at a time. Throws as `copyToClipboard` does for the
 * clipboard, for a copy whose pieces are not held, and for a picture that is not a PNG.
 */
export async function copyToClipboardUnlessChanged(
  clipboards: ClipboardHosts,
  pieces: ClipboardPieces,
  request: unknown,
): Promise<boolean> {
  const { copyId, since } = unlessChangedRequestSchema.parse(request);
  const host = hostNamed(clipboards, since.clipboard);
  const isHeld = () => pieces.isHeld(copyId);
  const flavors = await joinedFlavorsOf(pieces.copyOf(copyId), isHeld);
  // Electron reads only asynchronously: an app copying between this read and the write is lost.
  if (flavors === undefined || (await heldDigestOf(host)) !== since.digest || !isHeld()) {
    return false;
  }
  await host.write(flavors);
  return true;
}

/**
 * Add the formatted flavor of the copy a `{copyId}` request names beside the plain text the system
 * clipboard holds, writing both in one write, only while that text is still the copy's: `false`,
 * writing nothing, once a newer copy holds the clipboard or the copy's pieces were let go. The
 * copy's pieces are let go once it is decided. Throws a `ZodError` for a request but `{copyId}`,
 * and an `Error` for a copy whose pieces are not held or hold no formatted flavor.
 */
export async function addClipboardFormatting(
  clipboards: ClipboardHosts,
  pieces: ClipboardPieces,
  request: unknown,
): Promise<boolean> {
  const { copyId } = copyNamingSchema.parse(request);
  const copy = pieces.copyOf(copyId);
  if (copy.html.length === 0) {
    pieces.drop(copyId);
    throw new Error("A clipboard copy's formatting was asked for before its pieces were sent.");
  }
  const isHeld = () => pieces.isHeld(copyId);
  try {
    // Electron reads a clipboard only asynchronously, so an app writing between this read and the
    // write below loses its copy; no clipboard lets a reader make the two one step.
    const heldText = await clipboards.system.readText();
    const html = (await holdsPieces(heldText, copy.text, isHeld))
      ? await joinedInChunks(copy.html, isHeld)
      : undefined;
    if (html === undefined || !isHeld()) {
      return false;
    }
    await clipboards.system.write({ "text/plain": heldText, "text/html": html });
    return true;
  } finally {
    pieces.drop(copyId);
  }
}

/** The clipboard `clipboard` names; throws for the selection one where the system keeps none. */
function hostNamed(clipboards: ClipboardHosts, clipboard: "selection" | undefined): ClipboardHost {
  const host = clipboard === undefined ? clipboards.system : clipboards.selection;
  if (host === undefined) {
    throw new Error("This system keeps no selection clipboard.");
  }
  return host;
}

/**
 * The flavors of a late copy: its picture's pieces as one blob, or its text and formatted flavor
 * each joined from its pieces a chunk at a time; `undefined` once `isHeld` answers its pieces were
 * let go. Throws for a picture that is not a PNG.
 */
async function joinedFlavorsOf(
  copy: HeldClipboardCopy,
  isHeld: () => boolean,
): Promise<ClipboardFlavors | undefined> {
  if (copy.png.length > 0) {
    if (!opensWithPngSignature(copy.png)) {
      throw new Error("The picture is not a PNG.");
    }
    return { "image/png": new Blob([...copy.png], { type: "image/png" }) };
  }
  const text = await joinedInChunks(copy.text, isHeld);
  const html = copy.html.length === 0 ? undefined : await joinedInChunks(copy.html, isHeld);
  if (text === undefined || (copy.html.length > 0 && html === undefined)) {
    return undefined;
  }
  return html === undefined ? { "text/plain": text } : { "text/plain": text, "text/html": html };
}

/**
 * `pieces` joined, each chunk of them copied into one string in a task of its own and the chunks
 * linked, which copies nothing; `undefined` once `isHeld` answers the pieces were let go.
 */
async function joinedInChunks(
  pieces: readonly string[],
  isHeld: () => boolean,
): Promise<string | undefined> {
  let joined = "";
  let chunk: string[] = [];
  let chunkLength = 0;
  for (const piece of pieces) {
    if (chunk.length > 0 && chunkLength + piece.length > MAIN_TASK_CHUNK) {
      joined += chunk.join("");
      chunk = [];
      chunkLength = 0;
      await nextTask();
      if (!isHeld()) {
        return undefined;
      }
    }
    chunk.push(piece);
    chunkLength += piece.length;
  }
  return joined + chunk.join("");
}

/** Whether a picture's first bytes, across its first pieces, are the PNG signature. */
function opensWithPngSignature(pieces: readonly Uint8Array[]): boolean {
  let checked = 0;
  for (const piece of pieces) {
    for (const byte of piece.subarray(0, PNG_SIGNATURE.length - checked)) {
      if (byte !== PNG_SIGNATURE[checked]) {
        return false;
      }
      checked += 1;
    }
    if (checked === PNG_SIGNATURE.length) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `text` is `pieces` joined, compared a chunk of pieces in a task; `false` once `isHeld`
 * answers the pieces were let go.
 */
async function holdsPieces(
  text: string,
  pieces: readonly string[],
  isHeld: () => boolean,
): Promise<boolean> {
  let offset = 0;
  let chunkLength = 0;
  for (const piece of pieces) {
    if (chunkLength + piece.length > MAIN_TASK_CHUNK) {
      chunkLength = 0;
      await nextTask();
      if (!isHeld()) {
        return false;
      }
    }
    if (!text.startsWith(piece, offset)) {
      return false;
    }
    offset += piece.length;
    chunkLength += piece.length;
  }
  return offset === text.length;
}

/**
 * A digest of each entry `host` holds: its flavor types and its text flavors' bytes, each counted
 * by its size so no two holdings run together. A picture or file is told apart by its types alone.
 * A flavor is read a chunk at a time, each chunk in a task of its own, which feeds one hash the
 * same bytes in the same order as one read would.
 */
async function heldDigestOf(host: ClipboardHost): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of await host.readHeld()) {
    hash.update(`entry:${String(entry.types.length)}\u0000`);
    for (const type of entry.types) {
      const bytes = type.startsWith("text/") ? await entry.read(type) : undefined;
      hash.update(`${type}\u0000${String(bytes?.size ?? 0)}\u0000`);
      for (let start = 0; bytes !== undefined && start < bytes.size; start += MAIN_TASK_CHUNK) {
        if (start > 0) {
          await nextTask();
        }
        const chunk = await bytes.slice(start, start + MAIN_TASK_CHUNK).arrayBuffer();
        hash.update(new Uint8Array(chunk));
      }
    }
  }
  return hash.digest("hex");
}
