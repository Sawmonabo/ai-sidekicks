// A copy reaches the clipboard as one write carrying every flavor, and the selection clipboard
// only where the system keeps one. A formatted flavor added after a copy's text joins it only while
// the clipboard still holds that text, and a copy written after it was asked for lands only while
// the clipboard holds what it held then.

import { describe, expect, it, vi } from "vitest";

import {
  addClipboardFormatting,
  clipboardHostsFor,
  copyToClipboard,
  copyToClipboardUnlessChanged,
  takeClipboardSnapshot,
  type ClipboardFlavors,
  type ClipboardHost,
  type ClipboardHosts,
} from "./clipboard.js";

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
              readText: async (type) => {
                const flavor = held[type];
                return typeof flavor === "string" ? flavor : expect.fail(`${type} is no text`);
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

  it("writes a picture as its PNG bytes alone, and refuses bytes that are not a PNG", async () => {
    const clipboard = recordingClipboard();
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x2a);

    await copyToClipboard(systemOnly(clipboard), { content: { png } });
    await expect(
      copyToClipboard(systemOnly(clipboard), { content: { png: Uint8Array.of(0x47, 0x49, 0x46) } }),
    ).rejects.toThrow("The picture is not a PNG.");

    expect(clipboard.write).toHaveBeenCalledTimes(1);
    const [[flavors]] = clipboard.write.mock.calls as [[Record<string, Blob>]];
    expect(Object.keys(flavors)).toStrictEqual(["image/png"]);
    expect(flavors["image/png"]?.type).toBe("image/png");
    expect(new Uint8Array(await flavors["image/png"]!.arrayBuffer())).toStrictEqual(png);
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

describe("a formatted flavor added after a copy's text", () => {
  it("joins the text while the clipboard holds it, and leaves a newer copy standing", async () => {
    const clipboard = holdingClipboard();
    const clipboards = systemOnly(clipboard);
    const formatting = { text: "**first**", html: "<strong>first</strong>" };

    await copyToClipboard(clipboards, { content: { text: formatting.text } });
    await expect(addClipboardFormatting(clipboards, formatting)).resolves.toBe(true);
    expect(clipboard.held).toStrictEqual({
      "text/plain": "**first**",
      "text/html": "<strong>first</strong>",
    });

    await copyToClipboard(clipboards, { content: { text: formatting.text } });
    // A second copy, from this app or another, lands while the first's formatting is made.
    await clipboard.write({ "text/plain": "a newer copy" });
    await expect(addClipboardFormatting(clipboards, formatting)).resolves.toBe(false);
    expect(clipboard.held).toStrictEqual({ "text/plain": "a newer copy" });
  });
});

describe("a copy written after it was asked for", () => {
  it("lands while the clipboard holds what it held then, and leaves a newer copy standing", async () => {
    const clipboard = holdingClipboard();
    const clipboards = systemOnly(clipboard);
    await clipboard.write({ "text/plain": "the person's older copy" });
    const content = { text: "a long selection, read" };

    const since = await takeClipboardSnapshot(clipboards, {});
    await expect(copyToClipboardUnlessChanged(clipboards, { content, since })).resolves.toBe(true);
    expect(clipboard.held).toStrictEqual({ "text/plain": "a long selection, read" });

    const later = await takeClipboardSnapshot(clipboards, {});
    // Another app copies while the selection's text is read; its copy carries formatting too.
    await clipboard.write({ "text/plain": "a long selection, read", "text/html": "<b>theirs</b>" });
    await expect(copyToClipboardUnlessChanged(clipboards, { content, since: later })).resolves.toBe(
      false,
    );
    expect(clipboard.held).toStrictEqual({
      "text/plain": "a long selection, read",
      "text/html": "<b>theirs</b>",
    });
  });
});
