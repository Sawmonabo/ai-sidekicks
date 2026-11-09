// A model's default row and its larger-window row share the model's id, so a choice must find its
// row by both. The daemon finds a row by the same case table, so a pick names one row on each side.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../../__tests__/case-table.test-support.js";
import { findProviderModelRow } from "../capabilities.js";
import { ProviderModelSchema } from "../methods.js";

const providerModelRowTable = readCaseTable(
  z
    .object({
      rows: z.array(ProviderModelSchema),
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
  it.each(providerModelRowTable.cases)(
    "finds $name",
    ({ modelId, largerWindow, expectedIndex }) => {
      const found = findProviderModelRow(providerModelRowTable.rows, modelId, largerWindow);
      expect(found).toBe(
        expectedIndex === null ? undefined : providerModelRowTable.rows[expectedIndex],
      );
    },
  );
});
