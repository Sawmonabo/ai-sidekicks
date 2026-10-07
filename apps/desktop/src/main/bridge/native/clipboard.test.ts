// A copy reaches the clipboard as one write carrying every flavor.

import { describe, expect, it, vi } from "vitest";

import { copyToClipboard, type ClipboardHost } from "./clipboard.js";

function recordingClipboard(): ClipboardHost & { readonly write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn(() => Promise.resolve()) };
}

describe("the clipboard copy", () => {
  it("writes the text and its formatted flavor together, and plain text alone", async () => {
    const clipboard = recordingClipboard();

    await copyToClipboard(clipboard, { text: "**done**", html: "<strong>done</strong>" });
    await copyToClipboard(clipboard, { text: "a person's own line" });

    expect(clipboard.write.mock.calls).toStrictEqual([
      [{ "text/plain": "**done**", "text/html": "<strong>done</strong>" }],
      [{ "text/plain": "a person's own line" }],
    ]);
  });

  it("writes a picture as its PNG bytes alone, and refuses bytes that are not a PNG", async () => {
    const clipboard = recordingClipboard();
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x2a);

    await copyToClipboard(clipboard, { png });
    await expect(
      copyToClipboard(clipboard, { png: Uint8Array.of(0x47, 0x49, 0x46) }),
    ).rejects.toThrow("The picture is not a PNG.");

    expect(clipboard.write).toHaveBeenCalledTimes(1);
    const [[flavors]] = clipboard.write.mock.calls as [[Record<string, Blob>]];
    expect(Object.keys(flavors)).toStrictEqual(["image/png"]);
    expect(flavors["image/png"]?.type).toBe("image/png");
    expect(new Uint8Array(await flavors["image/png"]!.arrayBuffer())).toStrictEqual(png);
  });
});
