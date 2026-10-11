// A copy reaches the clipboard as one write carrying every flavor, and the selection clipboard
// only where the system keeps one. A copy written after it was asked for, and every picture, is
// sent in pieces first, which main joins for its one write and refuses out of order or for a copy
// it does not hold; it lands only while the clipboard holds what it held then, and a formatted
// flavor added after its text joins it only while the clipboard still holds that text.

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ClipboardPieces } from "#shared/clipboard-pieces.js";
import {
  addClipboardFormatting,
  copyToClipboard,
  copyToClipboardUnlessChanged,
  dropClipboardPieces,
  takeClipboardPiece,
  takeClipboardSnapshot,
} from "./copies.js";
import type { ClipboardFlavors, ClipboardHost, ClipboardHosts } from "./host.js";
import { clipboardHostsFor } from "./platform.js";

// Electron's entry holds no `ClipboardItem` outside its own process; this one keeps its flavors.
vi.mock("electron", () => ({
  ClipboardItem: class {
    public constructor(public readonly flavors: unknown) {}
  },
}));

function recordingClipboard(): ClipboardHost & { readonly write: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn(() => Promise.resolve()),
    readText: () => Promise.resolve(""),
    readHeld: () => Promise.resolve([]),
  };
}

/** A clipboard holding what was last written to it, as a system clipboard does. */
function holdingClipboard(): ClipboardHost & { held: ClipboardFlavors | undefined } {
  const clipboard: ClipboardHost & { held: ClipboardFlavors | undefined } = {
    held: undefined,
    write: async (flavors) => {
      clipboard.held = flavors;
    },
    readText: async () =>
      clipboard.held !== undefined && "text/plain" in clipboard.held
        ? clipboard.held["text/plain"]
        : "",
    readHeld: async () => {
      const held: Partial<Record<string, string | Blob>> = { ...clipboard.held };
      return clipboard.held === undefined
        ? []
        : [
            {
              types: Object.keys(held),
              read: async (type) => {
                const flavor = held[type];
                return typeof flavor === "string"
                  ? new Blob([flavor])
                  : expect.fail(`${type} is no text`);
              },
            },
          ];
    },
  };
  return clipboard;
}

function systemOnly(clipboard: ClipboardHost): ClipboardHosts {
  return { system: clipboard, selection: undefined };
}

describe("the clipboard copy", () => {
  it("writes the text and its formatted flavor together, and plain text alone", async () => {
    const clipboard = recordingClipboard();

    await copyToClipboard(systemOnly(clipboard), {
      content: { text: "**done**", html: "<strong>done</strong>" },
    });
    await copyToClipboard(systemOnly(clipboard), { content: { text: "a person's own line" } });

    expect(clipboard.write.mock.calls).toStrictEqual([
      [{ "text/plain": "**done**", "text/html": "<strong>done</strong>" }],
      [{ "text/plain": "a person's own line" }],
    ]);
  });

  it("writes the selection clipboard on Linux alone, and refuses it where none is kept", async () => {
    const writesTo = (writes: unknown[]) =>
      ({ write: (items: unknown) => writes.push(items) }) as unknown as Electron.Clipboard;
    const systemWrites: unknown[] = [];
    const selectionWrites: unknown[] = [];
    const electronClipboard = {
      ...writesTo(systemWrites),
      selection: writesTo(selectionWrites),
    } as Electron.Clipboard;
    const request = { content: { text: "a settled line" }, clipboard: "selection" };

    await copyToClipboard(clipboardHostsFor("linux", electronClipboard), request);
    for (const platform of ["darwin", "win32"] as const) {
      await expect(
        copyToClipboard(clipboardHostsFor(platform, electronClipboard), request),
      ).rejects.toThrow("This system keeps no selection clipboard.");
    }

    expect(selectionWrites).toEqual([[{ flavors: { "text/plain": "a settled line" } }]]);
    expect(systemWrites).toStrictEqual([]);
  });
});

/** Sends `png` under `copyId` in pieces cut at `cuts`, its first piece first. */
function sendPicture(
  pieces: ClipboardPieces,
  copyId: string,
  png: Uint8Array<ArrayBuffer>,
  cuts: readonly number[],
): void {
  [0, ...cuts].forEach((start, index) => {
    const piece = png.slice(start, cuts[index] ?? png.length);
    takeClipboardPiece(pieces, { copyId, flavor: "png", index, piece });
  });
}

/** Sends `pieces` each of `flavors` under `copyId`, in two pieces, its first piece first. */
function sendInPieces(
  pieces: ClipboardPieces,
  copyId: string,
  flavors: Partial<Record<"text" | "html", string>>,
): void {
  for (const flavor of ["text", "html"] as const) {
    const whole = flavors[flavor];
    if (whole !== undefined) {
      const cut = Math.floor(whole.length / 2);
      takeClipboardPiece(pieces, { copyId, flavor, index: 0, piece: whole.slice(0, cut) });
      takeClipboardPiece(pieces, { copyId, flavor, index: 1, piece: whole.slice(cut) });
    }
  }
}

describe("a late copy's pieces", () => {
  it("refuses a piece out of order, letting its copy go, and leaves a newer copy standing", async () => {
    const clipboard = holdingClipboard();
    const clipboards = systemOnly(clipboard);
    const pieces = new ClipboardPieces();
    const since = await takeClipboardSnapshot(clipboards, {});
    const write = (copyId: string) =>
      copyToClipboardUnlessChanged(clipboards, pieces, { copyId, since });

    takeClipboardPiece(pieces, { copyId: "first", flavor: "text", index: 0, piece: "a long " });
    expect(() =>
      takeClipboardPiece(pieces, { copyId: "first", flavor: "text", index: 2, piece: "end" }),
    ).toThrow("A clipboard piece came out of order.");
    await expect(write("first")).rejects.toThrow(
      "A clipboard piece names a copy that is not held.",
    );

    // A newer copy's first piece takes the place of the older one, whose later pieces are refused.
    takeClipboardPiece(pieces, { copyId: "older", flavor: "text", index: 0, piece: "older " });
    sendInPieces(pieces, "newer", { text: "the newer copy" });
    expect(() =>
      takeClipboardPiece(pieces, { copyId: "older", flavor: "text", index: 1, piece: "text" }),
    ).toThrow("A clipboard piece names a copy that is not held.");
    await expect(write("older")).rejects.toThrow(
      "A clipboard piece names a copy that is not held.",
    );
    await expect(write("newer")).resolves.toBe(true);
    expect(clipboard.held).toStrictEqual({ "text/plain": "the newer copy" });
  });
});

/** The PNG signature, then bytes no text decoding keeps: a lone continuation byte, NUL, 0xFF. */
const PICTURE = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x80,
  0x00,
  0xff,
  0xc3,
);

describe("a picture copy's pieces", () => {
  it("writes the picture's bytes as sent, and refuses bytes that are not a PNG", async () => {
    const clipboard = holdingClipboard();
    const clipboards = systemOnly(clipboard);
    const pieces = new ClipboardPieces();
    const write = async (copyId: string) =>
      copyToClipboardUnlessChanged(clipboards, pieces, {
        copyId,
        since: await takeClipboardSnapshot(clipboards, {}),
      });

    // Cut inside the signature, so it is read across pieces.
    sendPicture(pieces, "picture", PICTURE, [3, 9]);
    await expect(write("picture")).resolves.toBe(true);
    const held = clipboard.held ?? expect.fail("the clipboard holds the picture");
    expect(Object.keys(held)).toStrictEqual(["image/png"]);
    const picture = "image/png" in held ? held["image/png"] : expect.fail("a picture");
    expect(picture.type).toBe("image/png");
    expect(new Uint8Array(await picture.arrayBuffer())).toStrictEqual(PICTURE);

    sendPicture(pieces, "gif", Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00), [4]);
    await expect(write("gif")).rejects.toThrow("The picture is not a PNG.");
    expect(clipboard.held).toBe(held);
  });

  it("writes nothing for a picture let go before or while it is written", async () => {
    const clipboard = holdingClipboard();
    const clipboards = systemOnly(clipboard);
    const pieces = new ClipboardPieces();
    const since = await takeClipboardSnapshot(clipboards, {});
    const write = (copyId: string) =>
      copyToClipboardUnlessChanged(clipboards, pieces, { copyId, since });

    sendPicture(pieces, "dropped", PICTURE, [4]);
    dropClipboardPieces(pieces, { copyId: "dropped" });
    await expect(write("dropped")).rejects.toThrow(
      "A clipboard piece names a copy that is not held.",
    );

    // A newer copy's first piece arrives while main reads what the clipboard holds.
    sendPicture(pieces, "older", PICTURE, [4]);
    vi.spyOn(clipboard, "readHeld").mockImplementationOnce(async () => {
      takeClipboardPiece(pieces, { copyId: "newer", flavor: "text", index: 0, piece: "newer" });
      return [];
    });
    await expect(write("older")).resolves.toBe(false);
    expect(clipboard.held).toBeUndefined();
  });
});

describe("a formatted flavor added after a copy's text", () => {
  it("joins the text while the clipboard holds it, and leaves a newer copy standing", async () => {
    const clipboard = holdingClipboard();
    const clipboards = systemOnly(clipboard);
    const pieces = new ClipboardPieces();
    const formatting = { text: "**first**", html: "<strong>first</strong>" };
    const writeText = async (copyId: string) => {
      sendInPieces(pieces, copyId, { text: formatting.text });
      const since = await takeClipboardSnapshot(clipboards, {});
      await copyToClipboardUnlessChanged(clipboards, pieces, { copyId, since });
      sendInPieces(pieces, copyId, { html: formatting.html });
    };

    await writeText("first");
    await expect(addClipboardFormatting(clipboards, pieces, { copyId: "first" })).resolves.toBe(
      true,
    );
    expect(clipboard.held).toStrictEqual({
      "text/plain": "**first**",
      "text/html": "<strong>first</strong>",
    });
    // The formatting lets the copy's pieces go.
    await expect(addClipboardFormatting(clipboards, pieces, { copyId: "first" })).rejects.toThrow(
      "A clipboard piece names a copy that is not held.",
    );

    await writeText("second");
    // A newer copy, from this app or another, lands while the first's formatting is made.
    await clipboard.write({ "text/plain": "a newer copy" });
    await expect(addClipboardFormatting(clipboards, pieces, { copyId: "second" })).resolves.toBe(
      false,
    );
    expect(clipboard.held).toStrictEqual({ "text/plain": "a newer copy" });
  });
});

describe("a copy written after it was asked for", () => {
  it("lands while the clipboard holds what it held then, and leaves a newer copy standing", async () => {
    const clipboard = holdingClipboard();
    const clipboards = systemOnly(clipboard);
    const pieces = new ClipboardPieces();
    await clipboard.write({ "text/plain": "the person's older copy" });
    const flavors = { text: "a long selection, read", html: "<p>a long selection, read</p>" };
    sendInPieces(pieces, "copy", flavors);

    const since = await takeClipboardSnapshot(clipboards, {});
    await expect(
      copyToClipboardUnlessChanged(clipboards, pieces, { copyId: "copy", since }),
    ).resolves.toBe(true);
    expect(clipboard.held).toStrictEqual({
      "text/plain": "a long selection, read",
      "text/html": "<p>a long selection, read</p>",
    });

    const later = await takeClipboardSnapshot(clipboards, {});
    // Another app copies while the selection's text is read; its copy carries formatting too.
    await clipboard.write({ "text/plain": "a long selection, read", "text/html": "<b>theirs</b>" });
    await expect(
      copyToClipboardUnlessChanged(clipboards, pieces, { copyId: "copy", since: later }),
    ).resolves.toBe(false);
    expect(clipboard.held).toStrictEqual({
      "text/plain": "a long selection, read",
      "text/html": "<b>theirs</b>",
    });
  });
});

describe("a long copy on main's thread", () => {
  it("digests what the clipboard holds a chunk at a time as one read would", async () => {
    const clipboard = holdingClipboard();
    // Several mebibytes, a character of three bytes and one of four sitting across every chunk.
    const text = "€ and 😀 then a line\n".repeat(200_000);
    await clipboard.write({ "text/plain": text });
    const bytes = new TextEncoder().encode(text);
    const oneRead = createHash("sha256")
      .update("entry:1\u0000")
      .update(`text/plain\u0000${String(bytes.length)}\u0000`)
      .update(bytes)
      .digest("hex");

    await expect(takeClipboardSnapshot(systemOnly(clipboard), {})).resolves.toStrictEqual({
      digest: oneRead,
    });
  });

  it("stops joining a copy whose pieces are let go mid-join, and writes nothing", async () => {
    const clipboard = holdingClipboard();
    const readHeld = vi.spyOn(clipboard, "readHeld");
    const clipboards = systemOnly(clipboard);
    const pieces = new ClipboardPieces();
    const since = await takeClipboardSnapshot(clipboards, {});
    readHeld.mockClear();
    const piece = "a".repeat(700_000);
    for (const index of [0, 1, 2]) {
      takeClipboardPiece(pieces, { copyId: "older", flavor: "text", index, piece });
    }

    const writing = copyToClipboardUnlessChanged(clipboards, pieces, { copyId: "older", since });
    // A newer copy's first piece arrives while the older one's pieces are joined.
    takeClipboardPiece(pieces, { copyId: "newer", flavor: "text", index: 0, piece: "newer" });

    await expect(writing).resolves.toBe(false);
    // The join stopped where it stood: the clipboard was never read for the older copy.
    expect(readHeld).not.toHaveBeenCalled();
    expect(clipboard.held).toBeUndefined();
  });
});
