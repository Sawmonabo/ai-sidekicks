// A hunk body line whose prefix no line kind has: the patch comes from outside the window, so
// the line is drawn and recorded rather than thrown on or dropped.

import { describe, expect, it } from "vitest";

import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { diffLineText } from "../diff-model.js";
import { hunkLines } from "./hunk-lines.js";

describe("hunkLines — an unknown prefix", () => {
  it("draws the line as unchanged, keeps the numbers advancing, and records it", () => {
    const forwarded: string[] = [];
    const detach = windowDiagnosticCapture.installForwarder((jsonLines) => {
      forwarded.push(jsonLines);
    });
    try {
      const lines = hunkLines([" before", "?odd", "+after"], 10, 20);
      windowDiagnosticCapture.flush();

      expect(lines.map((line) => [line.kind, diffLineText(line)])).toEqual([
        ["context", "before"],
        ["context", "odd"],
        ["insert", "after"],
      ]);
      expect(lines[1]).toMatchObject({ baseLineNumber: 11, headLineNumber: 21 });
      expect(lines[2]).toMatchObject({ headLineNumber: 22 });
      expect(forwarded.join("\n")).toContain('"kind":"unknown-hunk-prefix"');
    } finally {
      detach();
    }
  });
});
