// `withEpochStamp`'s pairing refinement: a stamp needs both `sourceEpoch` and `sourcePosition` and
// a present, non-null `runId`; absence means the current epoch. Pairing cases assert the issue path
// so a base-parse failure cannot mask a missing refinement.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
  withEpochStamp,
} from "../event-envelope.js";

const RUN_ID = "990e8400-e29b-41d4-a716-446655440004";

// A run-scoped payload with a required `runId`, as every real run-scoped variant carries.
const runScopedPayloadSchema = z
  .object({
    runId: z.string().min(1),
    text: z.string(),
  })
  .strict();

// `runId` optional, so the "pair without runId" case passes the base parse and only the
// refinement's runId leg can reject it.
const optionalRunIdPayloadSchema = z
  .object({
    runId: z.string().min(1).optional(),
    text: z.string(),
  })
  .strict();

// `runId` nullable: the other spelling of "no run", which a key-presence check would wave
// through. `null` is what a nullable column or unresolved run handle produces.
const nullableRunIdPayloadSchema = z
  .object({
    runId: z.string().min(1).nullable(),
    text: z.string(),
  })
  .strict();

const stampedRunScoped = withEpochStamp(runScopedPayloadSchema);
const stampedOptionalRunId = withEpochStamp(optionalRunIdPayloadSchema);
const stampedNullableRunId = withEpochStamp(nullableRunIdPayloadSchema);

// Issue paths are asserted, not just `success: false`, so a pairing failure cannot be confused
// with a base-schema rejection.
const issuePaths = (result: z.ZodSafeParseResult<unknown>): string[] =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));

describe("withEpochStamp pairing refinement", () => {
  it("accepts an UNSTAMPED payload — absence is the current-epoch signal", () => {
    // A required stamp would force producers to fabricate an attribution.
    const parsed = stampedRunScoped.parse({ runId: RUN_ID, text: "hi" });
    expect(parsed).toStrictEqual({ runId: RUN_ID, text: "hi" });
  });

  it("accepts a FULLY stamped payload (epoch + position + runId)", () => {
    const parsed = stampedRunScoped.parse({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: 0,
      sourcePosition: 4,
    });
    expect(parsed).toStrictEqual({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: 0,
      sourcePosition: 4,
    });
  });

  it("rejects sourceEpoch WITHOUT sourcePosition (pairing refinement)", () => {
    const result = stampedRunScoped.safeParse({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: 1,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(SOURCE_POSITION_PAYLOAD_KEY);
  });

  it("rejects sourcePosition WITHOUT sourceEpoch (pairing refinement)", () => {
    const result = stampedRunScoped.safeParse({
      runId: RUN_ID,
      text: "hi",
      sourcePosition: 1,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(SOURCE_EPOCH_PAYLOAD_KEY);
  });

  it("rejects a stamp key set to an EXPLICIT undefined (key present, value absent)", () => {
    // Not reachable over JSON, but in-process a spread of `number | undefined` sources plants
    // both keys unconditionally, and Zod 4 preserves them. A key-presence test would pass a
    // half-stamped row, which is why the refinement reads `!== undefined`.
    const missingEpoch = stampedRunScoped.safeParse({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: undefined,
      sourcePosition: 5,
    });
    expect(missingEpoch.success).toBe(false);
    expect(issuePaths(missingEpoch)).toContain(SOURCE_EPOCH_PAYLOAD_KEY);

    const missingPosition = stampedRunScoped.safeParse({
      runId: RUN_ID,
      text: "hi",
      sourceEpoch: 5,
      sourcePosition: undefined,
    });
    expect(missingPosition.success).toBe(false);
    expect(issuePaths(missingPosition)).toContain(SOURCE_POSITION_PAYLOAD_KEY);
  });

  it("rejects the PAIR without runId — the stamp is unattributable", () => {
    // The base parse succeeds here, so only the refinement's runId leg can reject.
    expect(optionalRunIdPayloadSchema.safeParse({ text: "hi" }).success).toBe(true);
    const result = stampedOptionalRunId.safeParse({
      text: "hi",
      sourceEpoch: 1,
      sourcePosition: 2,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("runId");
  });

  it("rejects the pair with an EXPLICITLY NULL runId — null is 'no run'", () => {
    // The key is present, so a key-presence check would admit this row; `null` names no run
    // just as absence does, so the refinement tests the value.
    const result = stampedNullableRunId.safeParse({
      runId: null,
      text: "hi",
      sourceEpoch: 1,
      sourcePosition: 2,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("runId");
  });
});
