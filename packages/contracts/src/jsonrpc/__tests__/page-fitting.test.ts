// A page built from the count must pass its byte cap, and a non-empty list must never yield an
// empty page. The daemon counts by the same case table, parsed strictly here with zod.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { countEntriesFittingOneFrame } from "../page-fitting.js";

const pageFittingCases = readCaseTable(
  z.array(
    z
      .object({
        note: z.string(),
        candidates: z.array(z.unknown()),
        maxCount: z.int().nonnegative(),
        budgetBytes: z.int().nonnegative(),
        fitted: z.int().nonnegative(),
      })
      .strict(),
  ),
  "jsonrpc/page-fitting.json",
);

describe("countEntriesFittingOneFrame", () => {
  it.each(pageFittingCases)("$note", ({ candidates, maxCount, budgetBytes, fitted }) => {
    expect(countEntriesFittingOneFrame(candidates, maxCount, budgetBytes)).toBe(fitted);
  });
});
