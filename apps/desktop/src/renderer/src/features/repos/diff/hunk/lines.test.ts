// A hunk body line whose prefix no line kind has: the patch comes from outside the window, so
// the line is drawn and recorded rather than thrown on or dropped.

import { describe, expect, it } from "vitest";

import { collectSentDiagnostics } from "#test/helpers/sent-diagnostics.js";
import { diffLineText } from "../model.js";
import { hunkLines } from "./lines.js";

describe("hunkLines — an unknown prefix", () => {
  it("draws the line as unchanged, keeps the numbers advancing, and records it", async () => {
    const diagnostics = await collectSentDiagnostics();
    try {
      const lines = hunkLines([" before", "?odd", "+after"], 10, 20);

      expect(lines.map((line) => [line.kind, diffLineText(line)])).toEqual([
        ["context", "before"],
        ["context", "odd"],
        ["insert", "after"],
      ]);
      expect(lines[1]).toMatchObject({ baseLineNumber: 11, headLineNumber: 21 });
      expect(lines[2]).toMatchObject({ headLineNumber: 22 });
      expect((await diagnostics.records()).map((record) => record.kind)).toContain(
        "unknown-hunk-prefix",
      );
    } finally {
      diagnostics.stop();
    }
  });
});
