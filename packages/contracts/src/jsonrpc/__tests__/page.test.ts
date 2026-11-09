// A page holds as many leading entries as fit one frame. The daemon fits a page by the same case
// table, so a page one side builds the other accepts.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { countEntriesFittingOneFrame } from "../page.js";

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
