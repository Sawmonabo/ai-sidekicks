// The screen copy reads a title and the paste mode whole however the output is split across reads,
// and a title far past the wire's bound is cut on a grapheme, the sequences after it still read.

import { describe, expect, it } from "vitest";

import { SHELL_TITLE_MAX_LEN } from "@ai-sidekicks/contracts/pty";

import { ShellScreen } from "../screen.js";

// Feeds `output` to the screen `chunkByteLength` bytes at a time and waits for the parse.
async function writeInChunks(
  screen: ShellScreen,
  output: string,
  chunkByteLength: number,
): Promise<void> {
  const bytes = Buffer.from(output, "utf8");
  for (let start = 0; start < bytes.byteLength; start += chunkByteLength) {
    screen.write(bytes.subarray(start, start + chunkByteLength));
  }
  await screen.settle();
}

describe("ShellScreen", () => {
  it("reads a long title and the paste mode split across reads, the title cut on a grapheme", async () => {
    // Each accented letter is one grapheme of two UTF-16 units; the bound falls inside one.
    const graphemes = "é".repeat(2_000);
    const expectedTitle = `x${"é".repeat(Math.floor((SHELL_TITLE_MAX_LEN - 1) / 2))}`;
    const output = `plain\x18text\x1b]2;x${graphemes}\x07more\x1b[?2004h`;

    for (const chunkByteLength of [1, 7, output.length * 3]) {
      const screen = new ShellScreen({
        columns: 80,
        rows: 24,
        terminalVersion: "sidekicks test",
        readAppearance: () => ({ colors: null, cellSize: null }),
        answer: () => undefined,
        onTitleChange: () => undefined,
      });
      await writeInChunks(screen, output, chunkByteLength);
      expect(screen.title).toBe(expectedTitle);
      expect(screen.isBracketedPasteRequested).toBe(true);
      await writeInChunks(screen, "\x1b]0;short\x1b\\\x1b[?2004l", chunkByteLength);
      expect(screen.title).toBe("short");
      expect(screen.isBracketedPasteRequested).toBe(false);
      screen.dispose();
    }
  });
});
