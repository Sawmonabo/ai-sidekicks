// The page's copies, written by main: a plain line, the text with a formatted flavor beside it, or
// a PNG picture, in one write, so a paste target picks the flavor it understands. The page names
// the system clipboard or Linux's selection one, which a middle-click pastes. A copy whose content
// comes after it was asked for, and every picture, sends its text and formatted flavor or its
// picture's bytes in pieces first, which main holds for one copy per clipboard, within bounds on
// its size and its count of pieces, until the write joins them or the page that sent them goes.
// It writes only while the clipboard holds what it held then and this app wrote nothing to it
// since, and its formatted flavor, coming after its text, joins it only while the system clipboard
// still holds that text and no newer late copy was asked for, so a newer copy stands. Main's
// thread routes every window's input, so work that grows with a copy (joining its pieces, reading
// what the clipboard holds, comparing it) runs a bounded chunk at a time, other tasks let in
// between; Electron's own read and write calls are one step each.

import { createHash } from "node:crypto";
import { setImmediate as nextTask } from "node:timers/promises";

import * as z from "zod/mini";

import { ClipboardPieces, type HeldClipboardCopy } from "#shared/clipboard-pieces.js";
import type { ClipboardPiece, ClipboardSnapshot } from "#shared/preload-api.js";
import {
  MAIN_TASK_CHUNK,
  type ClipboardFlavors,
  type ClipboardHost,
  type ClipboardHosts,
} from "./host.js";

/** A page that sends a late copy's pieces: main lets its copies go once it is gone. */
export interface ClipboardPieceSender {
  readonly id: number;
  once(event: "destroyed", listener: () => void): unknown;
}

/**
 * Main's answers to the page's clipboard calls over `clipboards`: the copies it writes, and the
 * pieces of the late copy it holds for each clipboard. Each method throws a `ZodError` for a
 * request of the wrong shape, and an `Error` for the selection clipboard where the system keeps
 * none, before any clipboard is touched.
 */
export class ClipboardCopies {
  readonly #clipboards: ClipboardHosts;
  readonly #pieces = new ClipboardPieces();
  readonly #systemTally = new ClipboardTally();
  readonly #selectionTally = new ClipboardTally();
  /** The pages whose going main hears, so it lets their copies go. */
  readonly #watchedSenderIds = new Set<number>();

  public constructor(clipboards: ClipboardHosts) {
    this.#clipboards = clipboards;
  }

  /** Put the page's text on the clipboard it names in one write. */
  public async copyToClipboard(request: unknown): Promise<void> {
    const { content, clipboard } = copyRequestSchema.parse(request);
    const host = hostNamed(this.#clipboards, clipboard);
    const { text, html } = content;
    this.#tallyOf(clipboard).noteWrite();
    await host.write(
      html === undefined ? { "text/plain": text } : { "text/plain": text, "text/html": html },
    );
  }

  /**
   * What the clipboard the page names holds now, as the digest a later write compares against: the
   * count of this app's writes to it, taken as the request arrives, then each entry's flavor types
   * and its text flavors, read after.
   */
  public async takeClipboardSnapshot(request: unknown): Promise<ClipboardSnapshot> {
    const { clipboard } = snapshotRequestSchema.parse(request);
    const host = hostNamed(this.#clipboards, clipboard);
    // Taken before the read, so a write of this app's landing while it reads counts as newer.
    const writeCount = this.#tallyOf(clipboard).noteSnapshot();
    // An app copying between the key press and this read is taken as what was held, and replaced.
    const digest = digestWith(writeCount, await heldDigestOf(host));
    return clipboard === undefined ? { digest } : { clipboard, digest };
  }

  /**
   * Holds one piece of a late copy, for the clipboard it names, from `sender`. Throws for a piece
   * naming a copy not held or one out of order, and for a copy past its bounds on size or count of
   * pieces, which lets the copy go.
   */
  public takeClipboardPiece(request: unknown, sender: ClipboardPieceSender): void {
    const piece = clipboardPieceSchema.parse(request);
    this.#watch(sender);
    this.#pieces.take(piece);
    const tally = this.#tallyOf(piece.clipboard);
    if (piece.flavor !== "html" && piece.index === 0) {
      tally.startCopy(piece.copyId, sender.id);
    }
    if (!tally.countPiece(piece)) {
      this.#pieces.drop(piece.copyId);
      throw new Error("A clipboard copy is past main's bounds on its size or its count of pieces.");
    }
  }

  /** Lets the copy a `{copyId}` request names go, when it is held. */
  public dropClipboardPieces(request: unknown): void {
    this.#pieces.drop(copyNamingSchema.parse(request).copyId);
  }

  /**
   * Put a late copy on the clipboard its snapshot names, in one write, only while that clipboard
   * still holds what it held when the snapshot was taken and this app wrote nothing to it since:
   * `false`, writing nothing, once a newer copy holds it, or once main no longer holds the copy's
   * pieces. Its text and formatted flavor, or its picture, come from its pieces, text joined a
   * chunk at a time. Throws for a picture that is not a PNG.
   */
  public async copyToClipboardUnlessChanged(request: unknown): Promise<boolean> {
    const { copyId, since } = unlessChangedRequestSchema.parse(request);
    const host = hostNamed(this.#clipboards, since.clipboard);
    const isHeld = () => this.#pieces.isHeld(copyId);
    if (!isHeld()) {
      return false;
    }
    const flavors = await joinedFlavorsOf(this.#pieces.copyOf(copyId), isHeld);
    const tally = this.#tallyOf(since.clipboard);
    // Electron reads only asynchronously: an app copying between this read and the write is lost.
    const heldDigest = flavors === undefined ? undefined : await heldDigestOf(host);
    if (
      flavors === undefined ||
      heldDigest === undefined ||
      digestWith(tally.writeCount, heldDigest) !== since.digest ||
      !isHeld()
    ) {
      return false;
    }
    tally.noteWrite();
    tally.noteLanded(copyId);
    await host.write(flavors);
    return true;
  }

  /**
   * Add the formatted flavor of the copy a `{copyId}` request names beside the plain text the
   * system clipboard holds, writing both in one write, only while that text is still the copy's and
   * no late copy was asked for since the text landed: `false`, writing nothing, otherwise, or once
   * main no longer holds the copy's pieces. The copy's pieces are let go once it is decided. Throws
   * for a copy whose pieces hold no formatted flavor.
   */
  public async addClipboardFormatting(request: unknown): Promise<boolean> {
    const { copyId } = copyNamingSchema.parse(request);
    const isHeld = () => this.#pieces.isHeld(copyId);
    if (!isHeld()) {
      return false;
    }
    const copy = this.#pieces.copyOf(copyId);
    if (copy.html.length === 0) {
      this.#pieces.drop(copyId);
      throw new Error("A clipboard copy's formatting was asked for before its pieces were sent.");
    }
    const system = this.#clipboards.system;
    try {
      if (this.#systemTally.isSnapshotTakenSinceLanding(copyId)) {
        return false;
      }
      // Electron reads a clipboard only asynchronously, so an app writing between this read and the
      // write below loses its copy; no clipboard lets a reader make the two one step.
      const heldText = await system.readText();
      const html = (await holdsPieces(heldText, copy.text, isHeld))
        ? await joinedInChunks(copy.html, isHeld)
        : undefined;
      if (
        html === undefined ||
        !isHeld() ||
        this.#systemTally.isSnapshotTakenSinceLanding(copyId)
      ) {
        return false;
      }
      await system.write({ "text/plain": heldText, "text/html": html });
      return true;
    } finally {
      this.#pieces.drop(copyId);
    }
  }

  #tallyOf(clipboard: "selection" | undefined): ClipboardTally {
    return clipboard === undefined ? this.#systemTally : this.#selectionTally;
  }

  // One listener for each page's life, never one per copy.
  #watch(sender: ClipboardPieceSender): void {
    if (this.#watchedSenderIds.has(sender.id)) {
      return;
    }
    this.#watchedSenderIds.add(sender.id);
    sender.once("destroyed", () => {
      this.#watchedSenderIds.delete(sender.id);
      for (const tally of [this.#systemTally, this.#selectionTally]) {
        const copyId = tally.copyIdSentBy(sender.id);
        if (copyId !== undefined) {
          this.#pieces.drop(copyId);
        }
      }
    });
  }
}

/** The PNG signature, the eight bytes every PNG file opens with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * The longest text flavor a copy holds: V8's longest string, `2 ** 29 - 24` code units, since its
 * pieces are joined into one.
 */
const COPY_TEXT_MAX_LENGTH = 536_870_888;

/**
 * The most bytes of a copy's picture: the raw pixels of the largest canvas Chromium draws, 16,384
 * pixels square at four bytes a pixel.
 */
const COPY_PICTURE_MAX_BYTES = 1_073_741_824;

/**
 * The most pieces one copy holds, however short each one, which keeps main's lists of them small:
 * at eight bytes a list entry, 8 MiB.
 */
const COPY_MAX_PIECES = 1_048_576;

const copyNamingSchema = z.strictObject({ copyId: z.string() });

const clipboardContentSchema = z.strictObject({
  text: z.string(),
  html: z.optional(z.string()),
});

const pieceIndexSchema = z.int().check(z.minimum(0));

const clipboardNameSchema = z.optional(z.literal("selection"));

// A piece is at most one of main's task chunks, so taking and joining it stays within one task.
const clipboardPieceSchema = z.union([
  z.strictObject({
    copyId: z.string(),
    clipboard: clipboardNameSchema,
    flavor: z.enum(["text", "html"]),
    index: pieceIndexSchema,
    piece: z.string().check(z.maxLength(MAIN_TASK_CHUNK)),
  }),
  z.strictObject({
    copyId: z.string(),
    clipboard: clipboardNameSchema,
    flavor: z.literal("png"),
    index: pieceIndexSchema,
    // A `Uint8Array` arrives over IPC on its own `ArrayBuffer`, never a shared one.
    piece: z
      .instanceof(Uint8Array<ArrayBuffer>)
      .check(z.refine((bytes) => bytes.byteLength <= MAIN_TASK_CHUNK)),
  }),
]);

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
 * What main counts of one clipboard: the held copy's size, its count of pieces and the page that
 * sent it; this app's writes to it; and the snapshots taken of it, against the late copy that
 * landed last.
 */
class ClipboardTally {
  #copy: TalliedCopy | undefined;
  #writeCount = 0;
  #snapshotCount = 0;
  /** The late copy that landed last, and how many snapshots had been taken when it did. */
  #landed: { readonly copyId: string; readonly snapshotCount: number } | undefined;

  /** How many times this app wrote to the clipboard. */
  public get writeCount(): number {
    return this.#writeCount;
  }

  public noteWrite(): void {
    this.#writeCount += 1;
  }

  /** Counts a snapshot taken; the count of this app's writes it is taken after. */
  public noteSnapshot(): number {
    this.#snapshotCount += 1;
    return this.#writeCount;
  }

  public noteLanded(copyId: string): void {
    this.#landed = { copyId, snapshotCount: this.#snapshotCount };
  }

  /** Whether a snapshot was taken since the late copy `copyId` names landed, or it never did. */
  public isSnapshotTakenSinceLanding(copyId: string): boolean {
    return this.#landed?.copyId !== copyId || this.#landed.snapshotCount !== this.#snapshotCount;
  }

  public startCopy(copyId: string, senderId: number): void {
    this.#copy = { copyId, senderId, textLength: 0, htmlLength: 0, pictureBytes: 0, pieceCount: 0 };
  }

  /** Counts a piece of the held copy: whether the copy stays within its bounds. */
  public countPiece(piece: ClipboardPiece): boolean {
    const copy = this.#copy;
    if (copy?.copyId !== piece.copyId) {
      return true;
    }
    copy.pieceCount += 1;
    if (piece.flavor === "png") {
      copy.pictureBytes += piece.piece.byteLength;
    } else if (piece.flavor === "text") {
      copy.textLength += piece.piece.length;
    } else {
      copy.htmlLength += piece.piece.length;
    }
    return (
      copy.pieceCount <= COPY_MAX_PIECES &&
      copy.pictureBytes <= COPY_PICTURE_MAX_BYTES &&
      copy.textLength <= COPY_TEXT_MAX_LENGTH &&
      copy.htmlLength <= COPY_TEXT_MAX_LENGTH
    );
  }

  /** The held copy's id when the page `senderId` names sent it. */
  public copyIdSentBy(senderId: number): string | undefined {
    return this.#copy?.senderId === senderId ? this.#copy.copyId : undefined;
  }
}

/** A held copy as its clipboard's tally counts it. */
interface TalliedCopy {
  readonly copyId: string;
  readonly senderId: number;
  textLength: number;
  htmlLength: number;
  pictureBytes: number;
  pieceCount: number;
}

/** The clipboard `clipboard` names; throws for the selection one where the system keeps none. */
function hostNamed(clipboards: ClipboardHosts, clipboard: "selection" | undefined): ClipboardHost {
  const host = clipboard === undefined ? clipboards.system : clipboards.selection;
  if (host === undefined) {
    throw new Error("This system keeps no selection clipboard.");
  }
  return host;
}

/** A snapshot's digest: this app's writes counted, and the digest of what the clipboard holds. */
function digestWith(writeCount: number, heldDigest: string): string {
  return `${String(writeCount)}:${heldDigest}`;
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
