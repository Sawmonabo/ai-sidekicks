// The fold every name held once is compared by: workflow names in the library and the names typed
// for pasted-token accounts. The Rust fold reads the same case table, so the service and the
// desktop hold the same names apart, and a library upgrade that moves a fold fails here.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "./case-table.test-support.js";
import { foldName } from "../name-fold.js";

// `note` and `unicodeVersion` say how the table was made, for a person reading it. The Rust fold
// skips `laterCodePoints`, which only this library's newer data folds; here they fold as listed.
const nameFoldTable = readCaseTable(
  z
    .object({
      note: z.string(),
      unicodeVersion: z.string(),
      simpleFolds: z.array(z.int().nonnegative()),
      fullFolds: z.array(z.array(z.int().nonnegative()).min(2)),
      laterCodePoints: z.array(z.int().nonnegative()),
    })
    .strict(),
  "name-fold.json",
);

/** Each folded code point's fold; every code point missing here folds to itself. */
function tableFolds(): Map<number, string> {
  const folds = new Map<number, string>();
  for (let index = 0; index < nameFoldTable.simpleFolds.length; index += 2) {
    folds.set(
      nameFoldTable.simpleFolds[index] ?? expect.fail("a code point"),
      String.fromCodePoint(nameFoldTable.simpleFolds[index + 1] ?? expect.fail("its fold")),
    );
  }
  for (const [codePoint, ...fold] of nameFoldTable.fullFolds) {
    folds.set(codePoint ?? expect.fail("a code point"), String.fromCodePoint(...fold));
  }
  return folds;
}

describe("foldName", () => {
  // Every scalar value: the dotless ı, which no row names, must fold to itself and stay apart
  // from i, as ß must fold to ss and İ to i and a combining dot, never by the machine's language.
  it("folds every code point to the table's fold, or to itself where the table names none", () => {
    const folds = tableFolds();
    const misfolded: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        continue;
      }
      const text = String.fromCodePoint(codePoint);
      if (foldName(text) !== (folds.get(codePoint) ?? text)) {
        misfolded.push(codePoint.toString(16));
      }
    }
    expect(misfolded).toEqual([]);
  });
});
