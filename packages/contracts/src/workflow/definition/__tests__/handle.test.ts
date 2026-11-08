// A stored edge names its handles by string, and a document must always open: the parse never
// throws, and it keeps whether the string named a declared type so the save can refuse it. The
// daemon's parse reads the same case table, so both sides read a stored edge alike.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../../__tests__/case-table.test-support.js";
import { WORKFLOW_HANDLE_MODES, WORKFLOW_HANDLE_TYPES, parseWorkflowHandle } from "../handle.js";

const workflowHandleCases = readCaseTable(
  z.array(
    z
      .object({
        id: z.string(),
        handle: z
          .object({
            mode: z.enum(WORKFLOW_HANDLE_MODES),
            type: z.enum(WORKFLOW_HANDLE_TYPES),
            index: z.int().nonnegative(),
            isTypeKnown: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  ),
  "workflow-handle.json",
);

describe("parseWorkflowHandle", () => {
  // A string with no handle shape falls back to the first main output, marked unknown.
  it.each(workflowHandleCases)("reads $id as its side, type and index", ({ id, handle }) => {
    expect(parseWorkflowHandle(id)).toEqual(handle);
  });
});
