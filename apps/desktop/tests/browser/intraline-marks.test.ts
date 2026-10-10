// A long replaced pair keeps its word marks. The pair is too long for the window's own thread, so
// it is compared on the alignment worker, which only a real browser can start: the row reads its
// whole line first, and the changed words once the worker's alignment lands.

import { describe, expect, it } from "vitest";

import { parseUnifiedPatch } from "#renderer/features/repos/diff/patch-parse.js";
import { IntralineSegmentCache } from "#renderer/features/repos/diff/intraline/segment-cache.js";
import type { DiffLineRow } from "#renderer/features/repos/diff/rows/model.js";

/** How long the worker may take to start and answer. */
const LANDING_TIMEOUT_MS = 5000;

/** A minified-looking line of short statements, about 3,000 characters. */
function minifiedLine(renamed: ReadonlySet<number>): string {
  const statements: string[] = [];
  for (let ordinal = 0; ordinal < 450; ordinal += 1) {
    statements.push(`${renamed.has(ordinal) ? "q" : "v"}${String(ordinal)}=e;`);
  }
  return statements.join("");
}

describe("browser — the word marks of a long replaced pair", () => {
  it("marks exactly the renamed words of a 3,000-character pair", async () => {
    const previousText = minifiedLine(new Set());
    const nextText = minifiedLine(new Set([7, 220, 441]));
    expect(previousText.length).toBeGreaterThan(3000);
    const model = parseUnifiedPatch(
      [
        "--- bundle.js",
        "+++ bundle.js",
        "@@ -1 +1 @@",
        `-${previousText}`,
        `+${nextText}`,
        "",
      ].join("\n"),
      { baseRef: "main", headRef: "feature" },
    );
    const row: DiffLineRow = {
      kind: "line",
      fileIndex: 0,
      hunkIndex: 0,
      source: "hunk-body",
      lineIndex: 0,
    };
    const cache = new IntralineSegmentCache(model);
    const landed = new Promise<void>((resolve) => {
      cache.subscribe(resolve);
    });
    const firstLanding = cache.landingFor(row);
    // The first read starts the worker and draws the whole line meanwhile.
    expect(cache.readingFor(row, 0).segments).toStrictEqual([
      { text: previousText, changed: false },
    ]);
    await expect(
      Promise.race([
        landed,
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error("the alignment worker never answered"));
          }, LANDING_TIMEOUT_MS);
        }),
      ]),
    ).resolves.toBeUndefined();
    expect(cache.landingFor(row)).not.toBe(firstLanding);

    const changedWords = (lineIndex: number): string[] =>
      cache
        .readingFor({ ...row, lineIndex }, lineIndex)
        .segments.filter((segment) => segment.changed)
        .map((segment) => segment.text);
    expect(changedWords(0)).toStrictEqual(["v7", "v220", "v441"]);
    expect(changedWords(1)).toStrictEqual(["q7", "q220", "q441"]);
    // Both sides still read as the whole of their own line.
    expect(
      cache
        .readingFor(row, 0)
        .segments.map((segment) => segment.text)
        .join(""),
    ).toBe(previousText);
    cache.dispose();
  });
});
