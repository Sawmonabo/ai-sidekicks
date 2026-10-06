// The transcript rows the row and read suites start from, and the refusal assertion both use.
import { expect } from "vitest";

import type { RunRolledBackEvent } from "../../run/control.js";
import { TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE } from "../row.js";

/** The session every fixture row belongs to. */
export const SESSION_ID = "6f1c9a6e-1f2b-4a3c-8d5e-0a1b2c3d4e5f";
/** A second session, for rows that must not cross into the first. */
export const OTHER_SESSION_ID = "7a2d0b7f-2e3c-4b4d-9e6f-1b2c3d4e5f60";
/** The run the run-scoped fixture rows carry. */
export const RUN_ID = "11111111-2222-4333-8444-555555555555";
/** A second run, for rows that must not cross into the first. */
export const OTHER_RUN_ID = "22222222-3333-4444-8555-666666666666";
/** The parent of the fixture child run. */
export const PARENT_RUN_ID = "33333333-4444-4555-8666-777777777777";
/** The instant every fixture row carries. */
export const TIMESTAMP = "2026-09-01T12:00:00.000Z";
/** The cursor every fixture row carries. */
export const CURSOR = "seq-42";

/** The members every fixture row shares. */
export const rowCommon: Readonly<Record<string, unknown>> = {
  id: "evt-0001",
  sessionId: SESSION_ID,
  sequence: 42,
  cursor: CURSOR,
  category: "run_lifecycle",
  type: "run.started",
  summary: "Run started",
  timestamp: TIMESTAMP,
  payload: { detail: "opaque" },
};

/** A non-run row: every `run_lifecycle` event is run-scoped, so the general arm refuses it. */
export const generalRow: Readonly<Record<string, unknown>> = {
  ...rowCommon,
  kind: "general",
  category: "session_lifecycle",
  type: "session.created",
  summary: "Session created",
};

/** A row of one run, at a position in its first epoch. */
export const runScopedRow: {
  readonly epoch: number;
  readonly position: number;
  readonly [member: string]: unknown;
} = { ...rowCommon, kind: "run", runId: RUN_ID, position: 7, epoch: 0 };

/** The rollback the boundary row records. */
export const rolledBackPayload: RunRolledBackEvent = {
  sessionId: SESSION_ID as RunRolledBackEvent["sessionId"],
  runId: RUN_ID as RunRolledBackEvent["runId"],
  runVersion: 12,
  targetPosition: 5,
};

/** The boundary row a rollback of the fixture run leaves. */
export const rollbackBoundaryRow: Readonly<Record<string, unknown>> = {
  ...rowCommon,
  kind: "rollback_boundary",
  type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  summary: "Run rewound to position 5",
  runId: RUN_ID,
  position: 5,
  epoch: 0,
  payload: rolledBackPayload,
};

/** Parses `value` and asserts it is refused with an issue at `path`. */
export function expectRefusedAt(
  schema: { safeParse: (value: unknown) => SafeParseOutcome },
  value: unknown,
  path: string,
): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(path);
}

/** The part of a Zod parse result the refusal assertion reads. */
export interface SafeParseOutcome {
  success: boolean;
  error?: { issues: readonly { path: readonly PropertyKey[] }[] };
}
