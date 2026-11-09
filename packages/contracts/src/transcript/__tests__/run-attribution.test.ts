// The run a payload names, which files every transcript row under its run group. The daemon's
// projection reads the same case table, parsed strictly here with zod, so both file a row under
// the same run.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { transcriptOwnRunIdOf, transcriptRunIdOf } from "../run-attribution.js";

const runAttributionCases = readCaseTable(
  z.array(
    z
      .object({
        note: z.string(),
        payload: z.record(z.string(), z.unknown()).nullable(),
        runId: z.string().nullable(),
        ownRunId: z.string().nullable(),
      })
      .strict(),
  ),
  "transcript/run-attribution.json",
);

describe("reading the run a payload names", () => {
  it.each(runAttributionCases)("$note", ({ payload, runId, ownRunId }) => {
    expect(transcriptRunIdOf(payload ?? undefined) ?? null).toBe(runId);
    expect(transcriptOwnRunIdOf(payload ?? undefined) ?? null).toBe(ownRunId);
  });
});
