// A model's default row and its larger-window row share its id, so a choice finds its row by both.
// The Rust finder reads the same case table, parsed strictly here with zod.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../../__tests__/case-table.test-support.js";
import { findProviderModelRow } from "../model-row.js";

const providerModelRowCases = readCaseTable(
  z
    .object({
      rows: z.array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            capabilities: z.array(z.string()),
            fast: z.boolean(),
            largerWindow: z.boolean(),
            contextWindow: z.int().positive().optional(),
          })
          .strict(),
      ),
      cases: z.array(
        z
          .object({
            name: z.string(),
            modelId: z.string(),
            largerWindow: z.boolean(),
            expectedIndex: z.int().nonnegative().nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
  "provider-model-row.json",
);

describe("findProviderModelRow", () => {
  const { rows } = providerModelRowCases;
  it.each(providerModelRowCases.cases)(
    "finds $name",
    ({ modelId, largerWindow, expectedIndex }) => {
      const found = findProviderModelRow(rows, modelId, largerWindow);
      expect(found === undefined ? null : rows.indexOf(found)).toBe(expectedIndex);
    },
  );
});
