// A copy reaches the clipboard as one write carrying every flavor, and a malformed one not at all.

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

  it("refuses a bare string, a missing text and a non-string flavor without writing", async () => {
    const clipboard = recordingClipboard();
    const malformed = ["plain", { html: "<b>x</b>" }, { text: 3 }, { text: "x", html: 3 }, null];

    for (const content of malformed) {
      await expect(copyToClipboard(clipboard, content)).rejects.toThrow();
    }
    expect(clipboard.write).not.toHaveBeenCalled();
  });
});
