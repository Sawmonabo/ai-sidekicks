// A stored edge names its handles by string, and a document must always open: the parse never
// throws, and it keeps whether the string named a declared type so the save can refuse it. The
// daemon's parse reads the same case table, so both sides read a stored edge alike.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseWorkflowHandle } from "../handle.js";

const workflowHandleCases = z
  .array(
    z
      .object({
        id: z.string(),
        handle: z
          .object({
            mode: z.enum(["inputs", "outputs"]),
            type: z.enum(["main", "tool"]),
            index: z.int().nonnegative(),
            isTypeKnown: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../../crates/sidekicks-contracts/tests/fixtures/workflow-handle.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

describe("parseWorkflowHandle", () => {
  // A string with no handle shape falls back to the first main output, marked unknown.
  it.each(workflowHandleCases)("reads $id as its side, type and index", ({ id, handle }) => {
    expect(parseWorkflowHandle(id)).toEqual(handle);
  });
});
