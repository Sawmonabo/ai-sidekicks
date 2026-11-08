// A model's default row and its larger-window row share the model's id, so a choice must find its
// row by both. The daemon finds a row by the same case table, so a pick names one row on each side.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { findProviderModelRow } from "../capabilities.js";

const providerModelRowTable = z
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
  .strict()
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../../crates/sidekicks-contracts/tests/fixtures/provider-model-row.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
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
