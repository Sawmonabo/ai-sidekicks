// A copy reaches the clipboard as one write carrying every flavor, and the selection clipboard
// only where the system keeps one. A copy written after it was asked for, and every picture, is
// sent in pieces first, one copy held for each clipboard, which main joins for its one write and
// refuses out of order, past its bounds, or once the page that sent it is gone; it lands only while
// the clipboard holds what it held then and this app wrote nothing to it since, and a formatted
// flavor added after its text joins it only while the clipboard still holds that text.

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ClipboardSnapshot } from "#shared/preload-api.js";
import { ClipboardCopies, type ClipboardPieceSender } from "./copies.js";
import {
  clipboardHostsOn,
  MAIN_TASK_CHUNK,
  type ClipboardFlavors,
  type ClipboardHost,
  type ClipboardHosts,
} from "./host.js";
import { selectMainOperatingSystem } from "../../../operating-system/selection.js";

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

/** A page sending pieces, which goes when `destroy` is called. */
function sendingPage(id: number): ClipboardPieceSender & { readonly destroy: () => void } {
  const listeners: (() => void)[] = [];
  return {
    id,
    once: (_event, listener) => listeners.push(listener),
    destroy: () => {
      for (const listener of listeners.splice(0)) {
        listener();
      }
    },
  };
}

const PAGE = sendingPage(1);

describe("the clipboard copy", () => {
  it("writes the text and its formatted flavor together, and plain text alone", async () => {
    const clipboard = recordingClipboard();

    const copies = new ClipboardCopies(systemOnly(clipboard));
    await copies.copyToClipboard({
      content: { text: "**done**", html: "<strong>done</strong>" },
    });
    await copies.copyToClipboard({ content: { text: "a person's own line" } });

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

    await new ClipboardCopies(
      clipboardHostsOn(selectMainOperatingSystem("linux"), electronClipboard),
    ).copyToClipboard(request);
    for (const platform of ["darwin", "win32"] as const) {
      await expect(
        new ClipboardCopies(
          clipboardHostsOn(selectMainOperatingSystem(platform), electronClipboard),
        ).copyToClipboard(request),
      ).rejects.toThrow("This system keeps no selection clipboard.");
    }

    expect(selectionWrites).toEqual([[{ flavors: { "text/plain": "a settled line" } }]]);
    expect(systemWrites).toStrictEqual([]);
  });
});

/** Sends `png` under `copyId` in pieces cut at `cuts`, its first piece first. */
function sendPicture(
  copies: ClipboardCopies,
  copyId: string,
  png: Uint8Array<ArrayBuffer>,
  cuts: readonly number[],
): void {
  [0, ...cuts].forEach((start, index) => {
    const piece = png.slice(start, cuts[index] ?? png.length);
    copies.takeClipboardPiece({ copyId, flavor: "png", index, piece }, PAGE);
  });
}

/** Sends `pieces` each of `flavors` under `copyId`, in two pieces, its first piece first. */
function sendInPieces(
  copies: ClipboardCopies,
  copyId: string,
  flavors: Partial<Record<"text" | "html", string>>,
  clipboard?: "selection",
): void {
  for (const flavor of ["text", "html"] as const) {
    const whole = flavors[flavor];
    if (whole !== undefined) {
      const cut = Math.floor(whole.length / 2);
      for (const [index, piece] of [whole.slice(0, cut), whole.slice(cut)].entries()) {
        copies.takeClipboardPiece({ copyId, clipboard, flavor, index, piece }, PAGE);
      }
    }
  }
}

describe("a late copy's pieces", () => {
  it("refuses a piece out of order, letting its copy go, and leaves a newer copy standing", async () => {
    const clipboard = holdingClipboard();
    const copies = new ClipboardCopies(systemOnly(clipboard));
    const since = await copies.takeClipboardSnapshot({});
    const write = (copyId: string) => copies.copyToClipboardUnlessChanged({ copyId, since });

    copies.takeClipboardPiece(
      { copyId: "first", flavor: "text", index: 0, piece: "a long " },
      PAGE,
    );
    expect(() =>
      copies.takeClipboardPiece({ copyId: "first", flavor: "text", index: 2, piece: "end" }, PAGE),
    ).toThrow("A clipboard piece came out of order.");
    await expect(write("first")).resolves.toBe(false);

    // A newer copy's first piece takes the place of the older one, whose later pieces are refused.
    copies.takeClipboardPiece({ copyId: "older", flavor: "text", index: 0, piece: "older " }, PAGE);
    sendInPieces(copies, "newer", { text: "the newer copy" });
    expect(() =>
      copies.takeClipboardPiece({ copyId: "older", flavor: "text", index: 1, piece: "text" }, PAGE),
    ).toThrow("A clipboard piece names a copy that is not held.");
    await expect(write("older")).resolves.toBe(false);
    await expect(write("newer")).resolves.toBe(true);
    expect(clipboard.held).toStrictEqual({ "text/plain": "the newer copy" });
  });

  it("holds a copy for each clipboard, so neither lets the other's go", async () => {
    const system = holdingClipboard();
    const selection = holdingClipboard();
    const copies = new ClipboardCopies({ system, selection });
    const systemSince = await copies.takeClipboardSnapshot({});
    const selectionSince = await copies.takeClipboardSnapshot({ clipboard: "selection" });

    // A settled selection's copy and a long ⌘C send their pieces at once.
    sendInPieces(copies, "settled", { text: "the settled selection" }, "selection");
    sendInPieces(copies, "pressed", { text: "the pressed copy" });

    await expect(
      copies.copyToClipboardUnlessChanged({ copyId: "settled", since: selectionSince }),
    ).resolves.toBe(true);
    await expect(
      copies.copyToClipboardUnlessChanged({ copyId: "pressed", since: systemSince }),
    ).resolves.toBe(true);
    expect(selection.held).toStrictEqual({ "text/plain": "the settled selection" });
    expect(system.held).toStrictEqual({ "text/plain": "the pressed copy" });
  });

  it("refuses a piece past one task's chunk, and lets a copy go with the page that sent it", async () => {
    const clipboard = holdingClipboard();
    const copies = new ClipboardCopies(systemOnly(clipboard));
    const since = await copies.takeClipboardSnapshot({});
    const page = sendingPage(2);

    expect(() =>
      copies.takeClipboardPiece(
        { copyId: "long", flavor: "text", index: 0, piece: "a".repeat(MAIN_TASK_CHUNK + 1) },
        page,
      ),
    ).toThrow();
    copies.takeClipboardPiece({ copyId: "closed", flavor: "text", index: 0, piece: "kept" }, page);
    page.destroy();

    await expect(copies.copyToClipboardUnlessChanged({ copyId: "closed", since })).resolves.toBe(
      false,
    );
    expect(clipboard.held).toBeUndefined();
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
    const copies = new ClipboardCopies(systemOnly(clipboard));
    const write = async (copyId: string) =>
      copies.copyToClipboardUnlessChanged({
        copyId,
        since: await copies.takeClipboardSnapshot({}),
      });

    // Cut inside the signature, so it is read across pieces.
    sendPicture(copies, "picture", PICTURE, [3, 9]);
    await expect(write("picture")).resolves.toBe(true);
    const held = clipboard.held ?? expect.fail("the clipboard holds the picture");
    expect(Object.keys(held)).toStrictEqual(["image/png"]);
    const picture = "image/png" in held ? held["image/png"] : expect.fail("a picture");
    expect(picture.type).toBe("image/png");
    expect(new Uint8Array(await picture.arrayBuffer())).toStrictEqual(PICTURE);

    sendPicture(copies, "gif", Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00), [4]);
    await expect(write("gif")).rejects.toThrow("The picture is not a PNG.");
    expect(clipboard.held).toBe(held);
  });

  it("writes nothing for a picture let go before or while it is written", async () => {
    const clipboard = holdingClipboard();
    const copies = new ClipboardCopies(systemOnly(clipboard));
    const since = await copies.takeClipboardSnapshot({});
    const write = (copyId: string) => copies.copyToClipboardUnlessChanged({ copyId, since });

    sendPicture(copies, "dropped", PICTURE, [4]);
    copies.dropClipboardPieces({ copyId: "dropped" });
    await expect(write("dropped")).resolves.toBe(false);

    // A newer copy's first piece arrives while main reads what the clipboard holds.
    sendPicture(copies, "older", PICTURE, [4]);
    vi.spyOn(clipboard, "readHeld").mockImplementationOnce(async () => {
      copies.takeClipboardPiece(
        { copyId: "newer", flavor: "text", index: 0, piece: "newer" },
        PAGE,
      );
      return [];
    });
    await expect(write("older")).resolves.toBe(false);
    expect(clipboard.held).toBeUndefined();
  });
});

describe("a formatted flavor added after a copy's text", () => {
  it("joins the text while the clipboard holds it, and leaves a newer copy standing", async () => {
    const clipboard = holdingClipboard();
    const copies = new ClipboardCopies(systemOnly(clipboard));
    const formatting = { text: "**first**", html: "<strong>first</strong>" };
    const writeText = async (copyId: string) => {
      sendInPieces(copies, copyId, { text: formatting.text });
      const since = await copies.takeClipboardSnapshot({});
      await copies.copyToClipboardUnlessChanged({ copyId, since });
      sendInPieces(copies, copyId, { html: formatting.html });
    };

    await writeText("first");
    await expect(copies.addClipboardFormatting({ copyId: "first" })).resolves.toBe(true);
    expect(clipboard.held).toStrictEqual({
      "text/plain": "**first**",
      "text/html": "<strong>first</strong>",
    });
    // The formatting lets the copy's pieces go, so it is not added again.
    await expect(copies.addClipboardFormatting({ copyId: "first" })).resolves.toBe(false);

    await writeText("second");
    // A newer copy, from this app or another, lands while the first's formatting is made.
    await clipboard.write({ "text/plain": "a newer copy" });
    await expect(copies.addClipboardFormatting({ copyId: "second" })).resolves.toBe(false);
    expect(clipboard.held).toStrictEqual({ "text/plain": "a newer copy" });

    // A newer late copy asked for before the formatting is added stands in its place.
    await writeText("third");
    await copies.takeClipboardSnapshot({});
    await expect(copies.addClipboardFormatting({ copyId: "third" })).resolves.toBe(false);
    expect(clipboard.held).toStrictEqual({ "text/plain": "**first**" });
  });
});

describe("a copy written after it was asked for", () => {
  it("lands while the clipboard holds what it held then, and leaves a newer copy standing", async () => {
    const clipboard = holdingClipboard();
    const copies = new ClipboardCopies(systemOnly(clipboard));
    await clipboard.write({ "text/plain": "the person's older copy" });
    const flavors = { text: "a long selection, read", html: "<p>a long selection, read</p>" };
    sendInPieces(copies, "copy", flavors);

    const since = await copies.takeClipboardSnapshot({});
    await expect(copies.copyToClipboardUnlessChanged({ copyId: "copy", since })).resolves.toBe(
      true,
    );
    expect(clipboard.held).toStrictEqual({
      "text/plain": "a long selection, read",
      "text/html": "<p>a long selection, read</p>",
    });

    const later = await copies.takeClipboardSnapshot({});
    // Another app copies while the selection's text is read; its copy carries formatting too.
    await clipboard.write({ "text/plain": "a long selection, read", "text/html": "<b>theirs</b>" });
    await expect(
      copies.copyToClipboardUnlessChanged({ copyId: "copy", since: later }),
    ).resolves.toBe(false);
    expect(clipboard.held).toStrictEqual({
      "text/plain": "a long selection, read",
      "text/html": "<b>theirs</b>",
    });
  });

  it("gives way to a copy of this app's written while its snapshot was read", async () => {
    const clipboard = holdingClipboard();
    const copies = new ClipboardCopies(systemOnly(clipboard));
    sendInPieces(copies, "older", { text: "the older, late copy" });
    // The read the snapshot makes waits until a newer copy, asked for after it, is written.
    let releaseRead = (): void => undefined;
    const readHeld = clipboard.readHeld;
    vi.spyOn(clipboard, "readHeld").mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      return readHeld();
    });

    const snapshot: Promise<ClipboardSnapshot> = copies.takeClipboardSnapshot({});
    await copies.copyToClipboard({ content: { text: "the newer copy" } });
    releaseRead();
    const since = await snapshot;

    await expect(copies.copyToClipboardUnlessChanged({ copyId: "older", since })).resolves.toBe(
      false,
    );
    expect(clipboard.held).toStrictEqual({ "text/plain": "the newer copy" });
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

    // No write of this app's came before it.
    await expect(
      new ClipboardCopies(systemOnly(clipboard)).takeClipboardSnapshot({}),
    ).resolves.toStrictEqual({ digest: `0:${oneRead}` });
  });

  it("stops joining a copy whose pieces are let go mid-join, and writes nothing", async () => {
    const clipboard = holdingClipboard();
    const readHeld = vi.spyOn(clipboard, "readHeld");
    const copies = new ClipboardCopies(systemOnly(clipboard));
    const since = await copies.takeClipboardSnapshot({});
    readHeld.mockClear();
    const piece = "a".repeat(700_000);
    for (const index of [0, 1, 2]) {
      copies.takeClipboardPiece({ copyId: "older", flavor: "text", index, piece }, PAGE);
    }

    const writing = copies.copyToClipboardUnlessChanged({ copyId: "older", since });
    // A newer copy's first piece arrives while the older one's pieces are joined.
    copies.takeClipboardPiece({ copyId: "newer", flavor: "text", index: 0, piece: "newer" }, PAGE);

    await expect(writing).resolves.toBe(false);
    // The join stopped where it stood: the clipboard was never read for the older copy.
    expect(readHeld).not.toHaveBeenCalled();
    expect(clipboard.held).toBeUndefined();
  });
});
