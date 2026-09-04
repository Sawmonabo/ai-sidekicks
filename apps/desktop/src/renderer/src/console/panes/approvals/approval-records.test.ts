// What the reads accept, what they drop, and what they count.
//
// The claim worth a unit is not that a well-formed row parses — it is that a row
// this build cannot read is DROPPED AND COUNTED rather than rendered as a card with
// undefined fields, that a reply which is not shaped like the read at all throws
// rather than reporting an empty queue, and that the row this module accepts is the
// REGISTERED one rather than a shape a fixture once made up.

import { describe, expect, it } from "vitest";

import {
  APPROVAL_RECORD_MEMBERS,
  hasCompleteResolvedQuad,
  isResolvedState,
  readApprovalProjection,
  readRememberedRuleList,
  type ApprovalRecord,
} from "./approval-records.js";

/** One row of `ApprovalProjectionReadResponse.approvals`, spelled as it is registered. */
const REGISTERED_ROW = {
  id: "019b7a33-3300-7f01-8130-d1a4c1150523",
  runId: "019b7a33-3300-740e-8110-d1a4c1150511",
  requestedBy: "019b7a33-3300-7a6e-8110-d1a4c1150501",
  category: "file_write",
  scope: "session",
  resourceDescriptor: { path: "packages/contracts/src/approval.ts", bytes: 2048 },
  state: "pending",
  createdAt: "2026-01-01T13:30:00.900Z",
  updatedAt: "2026-01-01T13:30:00.900Z",
};

/**
 * The shape the console used to require, which no daemon ever answers.
 *
 * Kept as a value rather than described in a comment, because the assertion that
 * matters is that a reply in this spelling is now UNREADABLE — the negative control
 * on the whole adaptation.
 */
const FIXTURE_ONLY_ROW = {
  approvalRequestId: "019b7a33-3300-7f01-8130-d1a4c1150523",
  category: "file_write",
  state: "pending",
  requestedBy: "019b7a33-3300-7a6e-8110-d1a4c1150501",
  requestedScope: "session",
  resourceDescriptor: "write packages/contracts/src/approval.ts",
};

const WELL_FORMED_RULE = {
  ruleId: "rule-01",
  sessionId: "session-one",
  participantId: "participant-you",
  nodeId: "node-local",
  category: "tool_execution",
  scope: { kind: "session" },
  grantedAt: "2026-01-01T00:00:00.000Z",
};

describe("the projection read", () => {
  it("reads the registered reply and counts nothing unreadable", () => {
    const parsed = readApprovalProjection({ approvals: [REGISTERED_ROW] });
    expect(parsed.unreadableCount).toBe(0);
    expect(parsed.rows).toHaveLength(1);
    const row = parsed.rows[0];
    // `id` becomes `approvalRequestId` because that is what the registered resolve
    // request calls the same value; `scope` becomes `requestedScope` because the
    // reply carries a second scope and one word for both is how a surface starts
    // showing a granted scope where a requested one belongs.
    expect(row?.approvalRequestId).toBe(REGISTERED_ROW.id);
    expect(row?.requestedScope).toBe("session");
    expect(row?.runId).toBe(REGISTERED_ROW.runId);
    expect(row?.createdAt).toBe(REGISTERED_ROW.createdAt);
    expect(row?.updatedAt).toBe(REGISTERED_ROW.updatedAt);
    expect(row?.resourceDescriptor).toStrictEqual(REGISTERED_ROW.resourceDescriptor);
  });

  it("negative control: the same reply in the fixture-only spelling reads nothing", () => {
    // The row that used to be the only one this module accepted. It is now the row
    // no daemon sends, so it drops and is counted rather than rendering a card.
    const parsed = readApprovalProjection({ approvals: [FIXTURE_ONLY_ROW] });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.unreadableCount).toBe(1);
  });

  it("keeps a category and state this build does not know, verbatim", () => {
    // Parsed as strings and classified at render, deliberately: parsing them as
    // enums would drop a whole record over one unrecognized token, and the history
    // rule is that an unfiltered read drops nothing.
    const parsed = readApprovalProjection({
      approvals: [{ ...REGISTERED_ROW, category: "quantum_tunnelling", state: "shrugging" }],
    });
    expect(parsed.rows[0]?.category).toBe("quantum_tunnelling");
    expect(parsed.rows[0]?.state).toBe("shrugging");
  });

  it("reads a remembered scope as the object the wire declares", () => {
    const parsed = readApprovalProjection({
      approvals: [
        {
          ...REGISTERED_ROW,
          state: "approved",
          rememberedScope: { kind: "run", pattern: "packages/contracts/**" },
        },
      ],
    });
    expect(parsed.rows[0]?.rememberedScope).toStrictEqual({
      kind: "run",
      pattern: "packages/contracts/**",
    });
  });

  it("drops a row whose descriptor is not an object and counts it", () => {
    // The descriptor is a required `Record<string, unknown>`. A string there is the
    // shape failure that used to be the schema, so it has to be unreadable now.
    const parsed = readApprovalProjection({
      approvals: [REGISTERED_ROW, { ...REGISTERED_ROW, resourceDescriptor: "rm -rf /" }],
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.unreadableCount).toBe(1);
  });

  it("drops a row missing a required member and counts it", () => {
    const parsed = readApprovalProjection({
      approvals: [REGISTERED_ROW, { id: "019b7a33-3300-7f01-8140-d1a4c1150524" }],
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.unreadableCount).toBe(1);
  });

  it("negative control: a reply that is not the read throws rather than reading empty", () => {
    // Without this, a daemon answering something else entirely would render as
    // "nothing needs a decision" — the exact conflation this surface forbids.
    expect(() => readApprovalProjection({ requests: [] })).toThrow();
    expect(() => readApprovalProjection(undefined)).toThrow();
  });
});

describe("the record's member set is the registered one", () => {
  it("carries every registered member and no member the reply does not have", () => {
    const parsed = readApprovalProjection({
      // Two members that are on NO registered projection row: `askId` is on the
      // event payload and the persisted row, `auditMetadata` is on the resolve
      // request. A row carrying them still parses — the row schema is loose, so an
      // additive wire change never blanks the pane — and neither reaches the record.
      approvals: [{ ...REGISTERED_ROW, askId: "ask-11", auditMetadata: { origin: "tool" } }],
    });
    const row = parsed.rows[0];
    if (row === undefined) {
      throw new Error("the registered row did not parse");
    }
    expect(Object.keys(row).sort()).toStrictEqual([...APPROVAL_RECORD_MEMBERS].sort());
    expect("askId" in row).toBe(false);
    expect("auditMetadata" in row).toBe(false);
  });

  it("cannot be widened back to a member the reply does not carry", () => {
    // The planted foil for the runtime assertion above. `APPROVAL_RECORD_MEMBERS`
    // is annotated `readonly (keyof ApprovalRecord)[]`, so re-adding `askId` there
    // is the same compile error this line is: the member set cannot grow without
    // the interface growing first, and the interface is the registered reply.
    // @ts-expect-error `askId` is on no registered projection row.
    const plantedFoil: keyof ApprovalRecord = "askId";
    expect(plantedFoil).toBe("askId");
  });
});

describe("the standing-permission read", () => {
  it("keeps a rule and its optional revocation members", () => {
    const parsed = readRememberedRuleList({
      rules: [
        WELL_FORMED_RULE,
        {
          ...WELL_FORMED_RULE,
          ruleId: "rule-02",
          revokedAt: "2026-01-02T00:00:00.000Z",
          invalidationTrigger: "session_end",
        },
      ],
    });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1]?.invalidationTrigger).toBe("session_end");
  });

  it("drops a rule whose scope is not an object and counts it", () => {
    const parsed = readRememberedRuleList({
      rules: [{ ...WELL_FORMED_RULE, scope: "session" }],
    });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.unreadableCount).toBe(1);
  });

  it("negative control: a reply with no rules array throws", () => {
    expect(() => readRememberedRuleList({ grants: [] })).toThrow();
  });
});

// `runId` is present exactly when the scope kind is `run`. Enforced in BOTH
// directions, because a row that breaks it either way is a row this build renders as
// something the wire cannot mean — an active permission whose run boundary nobody
// can name, or a session-wide grant wearing a run association it does not have.
describe("a rule's run and its scope kind agree", () => {
  const RUN_SCOPED_RULE = {
    ...WELL_FORMED_RULE,
    scope: { kind: "run" },
    runId: "019b7a33-3300-740e-8110-d1a4c1150511",
  };

  it("drops a run-scoped rule that names no run, and counts it", () => {
    const { runId: _unused, ...withoutTheRun } = RUN_SCOPED_RULE;
    const parsed = readRememberedRuleList({ rules: [withoutTheRun] });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.unreadableCount).toBe(1);
  });

  it("drops a rule that is not run-scoped but names a run, and counts it", () => {
    const parsed = readRememberedRuleList({
      rules: [{ ...WELL_FORMED_RULE, runId: "019b7a33-3300-740e-8110-d1a4c1150511" }],
    });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.unreadableCount).toBe(1);
  });

  it("keeps both well-formed shapes", () => {
    const parsed = readRememberedRuleList({
      rules: [WELL_FORMED_RULE, { ...RUN_SCOPED_RULE, ruleId: "rule-02" }],
    });
    expect(parsed.unreadableCount).toBe(0);
    expect(parsed.rows.map((rule) => rule.runId)).toStrictEqual([
      undefined,
      "019b7a33-3300-740e-8110-d1a4c1150511",
    ]);
  });

  it("negative control: a kind this build does not know still reads, carrying no run", () => {
    // The refinement asks only whether this is the run kind. A fourth kind the
    // daemon grows is rendered as itself under this surface's wire-string rule, and
    // a refinement that had refused every unknown kind would have dropped it.
    const parsed = readRememberedRuleList({
      rules: [{ ...WELL_FORMED_RULE, scope: { kind: "workspace" } }],
    });
    expect(parsed.unreadableCount).toBe(0);
    expect(parsed.rows[0]?.scope.kind).toBe("workspace");
  });
});

describe("the resolved quad", () => {
  it("is required on exactly the two resolved states", () => {
    expect(isResolvedState("approved")).toBe(true);
    expect(isResolvedState("rejected")).toBe(true);
    expect(isResolvedState("expired")).toBe(false);
    expect(isResolvedState("canceled")).toBe(false);
    expect(isResolvedState("pending")).toBe(false);
  });

  it("is complete only when all four members are present", () => {
    const complete = readApprovalProjection({
      approvals: [
        {
          ...REGISTERED_ROW,
          state: "approved",
          resolvedAt: "2026-01-01T00:00:01.000Z",
          decision: "approved",
          approverId: "participant-you",
          effectiveScope: "session",
        },
      ],
    }).rows[0];
    if (complete === undefined) {
      throw new Error("the resolved row did not parse");
    }
    expect(hasCompleteResolvedQuad(complete)).toBe(true);
    // Negative control: dropping any one member has to make it incomplete, or the
    // card would render a partial resolution as if it were whole.
    expect(hasCompleteResolvedQuad({ ...complete, approverId: undefined })).toBe(false);
  });
});
