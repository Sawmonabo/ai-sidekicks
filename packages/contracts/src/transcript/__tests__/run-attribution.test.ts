// The run a payload names, which files every transcript row under its run group. The daemon's
// projection reads the same case table, so both file a row under the same run.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { transcriptOwnRunIdOf, transcriptRunIdOf } from "../run-attribution.js";

const runAttributionCases = z
  .array(
    z
      .object({
        note: z.string(),
        payload: z.record(z.string(), z.unknown()).nullable(),
        runId: z.string().nullable(),
        ownRunId: z.string().nullable(),
      })
      .strict(),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../crates/sidekicks-contracts/tests/fixtures/transcript/run-attribution.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

describe("reading the run a payload names", () => {
  it.each(runAttributionCases)("$note", ({ payload, runId, ownRunId }) => {
    expect(transcriptRunIdOf(payload ?? undefined) ?? null).toBe(runId);
    expect(transcriptOwnRunIdOf(payload ?? undefined) ?? null).toBe(ownRunId);
  });
});
