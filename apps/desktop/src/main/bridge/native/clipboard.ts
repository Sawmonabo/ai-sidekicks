// A clipboard, written by main for the page: a plain line, the text with a formatted flavor beside
// it, or a PNG picture, in one write, so a paste target picks the flavor it understands. The page
// names the system clipboard or Linux's selection one, which a middle-click pastes. Which
// clipboards a system keeps is chosen once, from its platform. A copy whose formatted flavor comes
// after its text adds it only while the system clipboard still holds that text, and a copy whose
// content comes after it was asked for writes only while the clipboard holds what it held then, so
// a newer copy stands.

import { createHash } from "node:crypto";

import { ClipboardItem } from "electron";
import * as z from "zod/mini";

import type { ClipboardSnapshot } from "#shared/preload-api.js";

/** Each flavor one copy writes, by its MIME type: text with its formatting, or a picture. */
export type ClipboardFlavors =
  | { readonly "text/plain": string; readonly "text/html"?: string }
  | { readonly "image/png": Blob };

/** One entry a clipboard holds: the types of its flavors, and a text flavor read by its type. */
export interface HeldClipboardEntry {
  readonly types: readonly string[];
  readText(type: string): Promise<string>;
}

/**
 * One clipboard over Electron's: writes one entry with one `ClipboardItem`, and reads its text and
 * the entries it holds.
 */
export interface ClipboardHost {
  write(flavors: ClipboardFlavors): Promise<void>;
  /** The plain text the clipboard holds now, empty when it holds none. */
  readText(): Promise<string>;
  readHeld(): Promise<readonly HeldClipboardEntry[]>;
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

const formattingRequestSchema = z.strictObject({ text: z.string(), html: z.string() });

const clipboardNameSchema = z.optional(z.literal("selection"));

const copyRequestSchema = z.strictObject({
  content: clipboardContentSchema,
  clipboard: clipboardNameSchema,
});

const snapshotRequestSchema = z.strictObject({ clipboard: clipboardNameSchema });

const unlessChangedRequestSchema = z.strictObject({
  content: clipboardContentSchema,
  since: z.strictObject({ clipboard: clipboardNameSchema, digest: z.string() }),
});

/**
 * Put the page's content on the clipboard it names in one write. Throws a `ZodError` for content
 * but `{text}`, `{text, html}` with string values, or `{png}` holding a PNG file's bytes, or a
 * clipboard but `"selection"`, and an `Error` for the selection one where the system keeps none,
 * before any clipboard is touched.
 */
export async function copyToClipboard(clipboards: ClipboardHosts, request: unknown): Promise<void> {
  const { content, clipboard } = copyRequestSchema.parse(request);
  await hostNamed(clipboards, clipboard).write(flavorsOf(content));
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
 * Put the page's content on the clipboard its snapshot names, in one write, only while that
 * clipboard still holds what it held when the snapshot was taken: `false`, writing nothing, once a
 * newer copy holds it. Throws as `copyToClipboard` does.
 */
export async function copyToClipboardUnlessChanged(
  clipboards: ClipboardHosts,
  request: unknown,
): Promise<boolean> {
  const { content, since } = unlessChangedRequestSchema.parse(request);
  const host = hostNamed(clipboards, since.clipboard);
  // Electron reads only asynchronously: an app copying between this read and the write is lost.
  if ((await heldDigestOf(host)) !== since.digest) {
    return false;
  }
  await host.write(flavorsOf(content));
  return true;
}

/**
 * Add the formatted flavor beside the plain text the system clipboard holds, writing both in one
 * write, only while that text is still the request's `text`: `false`, writing nothing, once a
 * newer copy holds the clipboard. Throws a `ZodError` for a request but `{text, html}` with string
 * values.
 */
export async function addClipboardFormatting(
  clipboards: ClipboardHosts,
  request: unknown,
): Promise<boolean> {
  const { text, html } = formattingRequestSchema.parse(request);
  // Electron reads a clipboard only asynchronously, so an app writing between this read and the
  // write below loses its copy; no clipboard lets a reader make the two one step.
  if ((await clipboards.system.readText()) !== text) {
    return false;
  }
  await clipboards.system.write({ "text/plain": text, "text/html": html });
  return true;
}

function clipboardHostOf(electronClipboard: Electron.Clipboard): ClipboardHost {
  return {
    write: (flavors) => electronClipboard.write([new ClipboardItem({ ...flavors })]),
    readText: () => electronClipboard.readText(),
    readHeld: async () =>
      (await electronClipboard.read()).map((item) => ({
        types: item.types,
        readText: async (type) => ((await item.getType(type)) as Blob).text(),
      })),
  };
}

/** The clipboard `clipboard` names; throws for the selection one where the system keeps none. */
function hostNamed(clipboards: ClipboardHosts, clipboard: "selection" | undefined): ClipboardHost {
  const host = clipboard === undefined ? clipboards.system : clipboards.selection;
  if (host === undefined) {
    throw new Error("This system keeps no selection clipboard.");
  }
  return host;
}

function flavorsOf(content: z.infer<typeof clipboardContentSchema>): ClipboardFlavors {
  if ("png" in content) {
    return { "image/png": new Blob([content.png], { type: "image/png" }) };
  }
  const { text, html } = content;
  return html === undefined ? { "text/plain": text } : { "text/plain": text, "text/html": html };
}

/**
 * A digest of each entry `host` holds: its flavor types and its text flavors, each counted by its
 * length so no two holdings run together. A picture or file is told apart by its types alone.
 */
async function heldDigestOf(host: ClipboardHost): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of await host.readHeld()) {
    hash.update(`entry:${String(entry.types.length)}\u0000`);
    for (const type of entry.types) {
      const text = type.startsWith("text/") ? await entry.readText(type) : "";
      hash.update(`${type}\u0000${String(text.length)}\u0000`);
      hash.update(text);
    }
  }
  return hash.digest("hex");
}
