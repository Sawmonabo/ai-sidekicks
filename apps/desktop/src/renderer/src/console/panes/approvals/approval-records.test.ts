// What the reads accept, what they drop, and what they count.
//
// The claim worth a unit is not that a well-formed row parses — it is that a row
// this build cannot read is DROPPED AND COUNTED rather than rendered as a card with
// undefined fields, and that a reply which is not shaped like the read at all
// throws rather than reporting an empty queue.

import { describe, expect, it } from "vitest";

import {
  hasCompleteResolvedQuad,
  isResolvedState,
  readApprovalProjection,
  readRememberedRuleList,
} from "./approval-records.js";

const WELL_FORMED_RECORD = {
  approvalRequestId: "approval-01",
  category: "file_write",
  state: "pending",
  requestedBy: "agent-one",
  requestedScope: "session",
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
  it("keeps a well-formed record and counts nothing unreadable", () => {
    const parsed = readApprovalProjection({ requests: [WELL_FORMED_RECORD] });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.unreadableCount).toBe(0);
  });

  it("keeps a category and state this build does not know, verbatim", () => {
    // Parsed as strings and classified at render, deliberately: parsing them as
    // enums would drop a whole record over one unrecognized token, and the history
    // rule is that an unfiltered read drops nothing.
    const parsed = readApprovalProjection({
      requests: [{ ...WELL_FORMED_RECORD, category: "quantum_tunnelling", state: "shrugging" }],
    });
    expect(parsed.rows[0]?.category).toBe("quantum_tunnelling");
    expect(parsed.rows[0]?.state).toBe("shrugging");
  });

  it("drops a row missing a required member and counts it", () => {
    const parsed = readApprovalProjection({
      requests: [WELL_FORMED_RECORD, { approvalRequestId: "approval-02" }],
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.unreadableCount).toBe(1);
  });

  it("negative control: a reply that is not the read throws rather than reading empty", () => {
    // Without this, a daemon answering something else entirely would render as
    // "nothing needs a decision" — the exact conflation this surface forbids.
    expect(() => readApprovalProjection({ approvals: [] })).toThrow();
    expect(() => readApprovalProjection(undefined)).toThrow();
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

describe("the resolved quad", () => {
  it("is required on exactly the two resolved states", () => {
    expect(isResolvedState("approved")).toBe(true);
    expect(isResolvedState("rejected")).toBe(true);
    expect(isResolvedState("expired")).toBe(false);
    expect(isResolvedState("canceled")).toBe(false);
    expect(isResolvedState("pending")).toBe(false);
  });

  it("is complete only when all four members are present", () => {
    const complete = {
      ...WELL_FORMED_RECORD,
      state: "approved",
      resolvedAt: "2026-01-01T00:00:01.000Z",
      decision: "approved",
      approverId: "participant-you",
      effectiveScope: "session",
    };
    expect(hasCompleteResolvedQuad(complete)).toBe(true);
    // Negative control: dropping any one member has to make it incomplete, or the
    // card would render a partial resolution as if it were whole.
    const { approverId: _approverId, ...missingApprover } = complete;
    expect(hasCompleteResolvedQuad(missingApprover)).toBe(false);
  });
});
