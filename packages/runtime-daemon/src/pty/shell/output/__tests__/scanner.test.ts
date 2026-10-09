// The output scanner reads a title and the paste mode whole however the output is split across
// reads, and a title far past the wire's bound is cut on a grapheme, the sequences after it still
// read.

import { describe, expect, it } from "vitest";

import { SHELL_TITLE_MAX_LEN } from "@ai-sidekicks/contracts/pty";

import { ShellOutputScanner } from "../scanner.js";

// Feeds `output` to the scanner `chunkByteLength` bytes at a time.
function scanInChunks(scanner: ShellOutputScanner, output: string, chunkByteLength: number): void {
  const bytes = Buffer.from(output, "utf8");
  for (let start = 0; start < bytes.byteLength; start += chunkByteLength) {
    scanner.scan(bytes.subarray(start, start + chunkByteLength));
  }
}

describe("ShellOutputScanner", () => {
  it("reads a long title and the paste mode split across reads, the title cut on a grapheme", () => {
    // Each accented letter is one grapheme of two UTF-16 units; the bound falls inside one.
    const graphemes = "e\u0301".repeat(2_000);
    const expectedTitle = `x${"e\u0301".repeat(Math.floor((SHELL_TITLE_MAX_LEN - 1) / 2))}`;
    const output = `plain\x18text\x1b]2;x${graphemes}\x07more\x1b[?2004h`;

    for (const chunkByteLength of [1, 7, output.length * 3]) {
      const scanner = new ShellOutputScanner();
      scanInChunks(scanner, output, chunkByteLength);
      expect(scanner.title).toBe(expectedTitle);
      expect(scanner.isBracketedPasteRequested).toBe(true);
      scanInChunks(scanner, "\x1b]0;short\x1b\\\x1b[?2004l", chunkByteLength);
      expect(scanner.title).toBe("short");
      expect(scanner.isBracketedPasteRequested).toBe(false);
    }
  });
});
