// Transcript rows keep the run attribution rollback projection keys on: a row never falls through
// to an arm that would drop it.
import { describe, expect, it } from "vitest";

import { refusesAt } from "../../__tests__/safe-parse.test-support.js";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
  TranscriptReadRowSchema,
} from "../row.js";
import {
  OTHER_SESSION_ID,
  RUN_ID,
  OTHER_RUN_ID,
  generalRow,
  runScopedRow,
  rolledBackPayload,
  rollbackBoundaryRow,
} from "./row.test-support.js";

describe("rollback projection keeps every row's run attribution", () => {
  it.each([
    ["epoch missing", { ...runScopedRow, epoch: undefined }],
    ["position missing", { ...runScopedRow, position: undefined }],
    ["runId missing", { ...runScopedRow, runId: undefined }],
    [
      "whole triple missing",
      { ...runScopedRow, runId: undefined, position: undefined, epoch: undefined },
    ],
  ] as const)("%s: a partial run row fails its own arm and never falls through", (_, row) => {
    const withoutUndefinedKeys = Object.fromEntries(
      Object.entries(row).filter(([, value]) => value !== undefined),
    );
    const result = TranscriptReadRowSchema.safeParse(withoutUndefinedKeys);
    expect(result.success).toBe(false);
    // A fallthrough would show as `invalid_union` at `kind` or as `unrecognized_keys` from the
    // general arm, which would strip the attribution the rollback rule keys on.
    expect(result.error?.issues.length).toBeGreaterThan(0);
    for (const issue of result.error?.issues ?? []) {
      expect(issue.code).toBe("invalid_type");
      expect(["runId", "position", "epoch"]).toContain(String(issue.path[0]));
    }
  });

  it("the general arm refuses every form of run attribution", () => {
    // A general row carries no runId, position or epoch, so rollback could never reach a run's
    // row misfiled there and it would render as permanently current.
    const artifactRow = {
      ...generalRow,
      category: "artifact_publication",
      type: "artifact.published",
    };
    const misfiled: readonly [Record<string, unknown>, string][] = [
      [{ ...generalRow, runId: RUN_ID, position: 7, epoch: 0 }, ""],
      [{ ...generalRow, runId: RUN_ID }, ""],
      [{ ...generalRow, category: TRANSCRIPT_RUN_LIFECYCLE_CATEGORY }, "category"],
      [{ ...generalRow, category: "assistant_output", type: "tool.result" }, "type"],
      [{ ...generalRow, category: "assistant_output", type: "intervention.applied" }, "type"],
      // `artifact.published` is session-scoped on one row and run-scoped on the next, so the
      // payload decides.
      [{ ...artifactRow, payload: { runId: RUN_ID } }, "payload.runId"],
      [{ ...artifactRow, payload: { targetRunId: RUN_ID } }, "payload.targetRunId"],
    ];
    for (const [row, path] of misfiled) {
      if (path === "") {
        expect(TranscriptReadRowSchema.safeParse(row).success).toBe(false);
      } else {
        refusesAt(TranscriptReadRowSchema, row, path);
      }
    }
    expect(TranscriptReadRowSchema.safeParse(generalRow).success).toBe(true);
    expect(TranscriptReadRowSchema.safeParse(artifactRow).success).toBe(true);
  });

  it("only the boundary arm carries the rollback event type", () => {
    // A run row typed `run.rolled_back` would reach a consumer narrowing on `kind` as an ordinary
    // row, with the rewind cutoff unread in its untyped payload.
    for (const row of [runScopedRow, generalRow]) {
      refusesAt(
        TranscriptReadRowSchema,
        { ...row, type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE },
        "type",
      );
      expect(TranscriptReadRowSchema.safeParse(row).success).toBe(true);
    }
    expect(TranscriptReadRowSchema.safeParse(rollbackBoundaryRow).success).toBe(true);
  });

  it("a boundary row agrees with its payload, and a broken payload fails without throwing", () => {
    refusesAt(TranscriptReadRowSchema, { ...rollbackBoundaryRow, runId: OTHER_RUN_ID }, "runId");
    refusesAt(
      TranscriptReadRowSchema,
      { ...rollbackBoundaryRow, sessionId: OTHER_SESSION_ID },
      "sessionId",
    );
    refusesAt(TranscriptReadRowSchema, { ...rollbackBoundaryRow, position: 9 }, "position");
    // None may escape the cross-field refinement as a TypeError.
    for (const payload of [
      { detail: "opaque" },
      { ...rolledBackPayload, runVersion: undefined },
      { ...rolledBackPayload, targetPosition: "5" },
      { ...rolledBackPayload, unexpected: true },
      null,
      "run.rolled_back",
    ]) {
      expect(TranscriptReadRowSchema.safeParse({ ...rollbackBoundaryRow, payload }).success).toBe(
        false,
      );
    }
    const parsed = TranscriptReadRowSchema.parse(rollbackBoundaryRow);
    expect(parsed.kind === "rollback_boundary" && parsed.payload.targetPosition).toBe(5);
  });

  it("a run row's payload attribution must agree with the row", () => {
    // Otherwise a row filed under run A could be sourced from run B, permanently and silently.
    const otherRunId = "99999999-8888-4777-8666-555555555555";
    for (const [payloadKey, payloadValue] of [
      ["runId", otherRunId],
      ["targetRunId", otherRunId],
      ["sourceEpoch", runScopedRow.epoch + 1],
      ["sourcePosition", runScopedRow.position + 1],
    ] as const) {
      refusesAt(
        TranscriptReadRowSchema,
        { ...runScopedRow, payload: { detail: "opaque", [payloadKey]: payloadValue } },
        `payload.${payloadKey}`,
      );
    }
    const agreeing = {
      ...runScopedRow,
      payload: { runId: RUN_ID, sourceEpoch: 0, sourcePosition: 7 },
    };
    expect(TranscriptReadRowSchema.safeParse(agreeing).success).toBe(true);
    expect(TranscriptReadRowSchema.safeParse(runScopedRow).success).toBe(true);
  });

  it("a superseded marker must rank below the row it marks", () => {
    const marked = (position: number) => ({
      ...runScopedRow,
      position,
      superseded: { targetPosition: 7 },
    });
    refusesAt(TranscriptReadRowSchema, marked(7), "superseded.targetPosition");
    expect(TranscriptReadRowSchema.safeParse(marked(6)).success).toBe(false);
    expect(TranscriptReadRowSchema.safeParse(marked(8)).success).toBe(true);
  });
});
