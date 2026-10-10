// A copy reaches the clipboard as one write carrying every flavor, and the selection clipboard
// only where the system keeps one.

import { describe, expect, it, vi } from "vitest";

import {
  clipboardHostsFor,
  copyToClipboard,
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
  return { write: vi.fn(() => Promise.resolve()) };
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
