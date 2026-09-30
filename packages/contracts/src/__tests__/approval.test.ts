// The approval surface's boundary: each call's request and reply accept what the
// card, the inspector's rules and the reviewer's block send, and refuse the
// shapes that would let an answer mean something the person did not press.
import { describe, expect, it } from "vitest";

import {
  ApprovalDenialOverrideRequestSchema,
  ApprovalProjectionReadResponseSchema,
  ApprovalRememberedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  ApprovalResolveRequestSchema,
  ApprovalReviewerDeniedPayloadSchema,
  RememberedRuleListResponseSchema,
  RememberedRuleRevokeResponseSchema,
} from "../approval.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const REQUEST_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RULE_ID = "1f2b4d5e-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "2f2b4d5e-cccc-4ccc-8ccc-cccccccccccc";
const RESOLUTION_ID = "3f2b4d5e-dddd-4ddd-8ddd-dddddddddddd";
const DENIAL_ID = "4f2b4d5e-eeee-4eee-8eee-eeeeeeeeeeee";
const AT = "2026-09-29T14:20:00.000Z";

const ALLOW_THIS_SESSION = { kind: "session", pattern: "pnpm test", sense: "allow" };

describe("ApprovalResolveRequestSchema", () => {
  it("accepts an approval that remembers an allow, and a decline with its why-not line", () => {
    const approve = {
      approvalRequestId: REQUEST_ID,
      decision: "approved",
      clientResolutionId: RESOLUTION_ID,
      editedAction: "pnpm test --filter contracts",
      rememberedScope: ALLOW_THIS_SESSION,
    };
    const decline = {
      approvalRequestId: REQUEST_ID,
      decision: "rejected",
      clientResolutionId: RESOLUTION_ID,
      declineReason: "run the narrower suite first",
      rememberedScope: { kind: "project", pattern: "api.example.com", sense: "block" },
    };
    expect(ApprovalResolveRequestSchema.safeParse(approve).success).toBe(true);
    expect(ApprovalResolveRequestSchema.safeParse(decline).success).toBe(true);
  });

  it("refuses a remembered sense that disagrees with the decision", () => {
    const approveThatBlocks = {
      approvalRequestId: REQUEST_ID,
      decision: "approved",
      clientResolutionId: RESOLUTION_ID,
      rememberedScope: { ...ALLOW_THIS_SESSION, sense: "block" },
    };
    expect(ApprovalResolveRequestSchema.safeParse(approveThatBlocks).success).toBe(false);
  });

  it("refuses decline text on an approval and an edited action on a decline", () => {
    const base = { approvalRequestId: REQUEST_ID, clientResolutionId: RESOLUTION_ID };
    expect(
      ApprovalResolveRequestSchema.safeParse({
        ...base,
        decision: "approved",
        declineReason: "no",
      }).success,
    ).toBe(false);
    expect(
      ApprovalResolveRequestSchema.safeParse({
        ...base,
        decision: "rejected",
        editedAction: "rm -rf build",
      }).success,
    ).toBe(false);
  });

  it("refuses an answer with no client resolution id, a run-scoped rule, and a rule with no subject", () => {
    const base = { approvalRequestId: REQUEST_ID, decision: "approved" };
    expect(ApprovalResolveRequestSchema.safeParse(base).success).toBe(false);
    const withId = { ...base, clientResolutionId: RESOLUTION_ID };
    expect(
      ApprovalResolveRequestSchema.safeParse({
        ...withId,
        rememberedScope: { ...ALLOW_THIS_SESSION, kind: "run" },
      }).success,
    ).toBe(false);
    expect(
      ApprovalResolveRequestSchema.safeParse({
        ...withId,
        rememberedScope: { kind: "session", sense: "allow" },
      }).success,
    ).toBe(false);
  });

  it("refuses a smuggled provider ask id", () => {
    const smuggled = {
      approvalRequestId: REQUEST_ID,
      decision: "approved",
      clientResolutionId: RESOLUTION_ID,
      askId: "ask-1",
    };
    expect(ApprovalResolveRequestSchema.safeParse(smuggled).success).toBe(false);
  });
});

const PENDING_ROW = {
  id: REQUEST_ID,
  runId: RUN_ID,
  requestedBy: "agent:claude",
  category: "tool_execution",
  scope: "pnpm test",
  resourceDescriptor: { command: "pnpm test" },
  subject: "pnpm test",
  reason: "The command writes outside the worktree.",
  standingAllowOffered: true,
  state: "pending",
  createdAt: AT,
  updatedAt: AT,
};
const RESOLVED_ROW = {
  ...PENDING_ROW,
  state: "approved",
  resolvedAt: AT,
  decision: "approved",
  approverId: USER_ID,
  effectiveScope: "pnpm test",
  rememberedScope: ALLOW_THIS_SESSION,
};

describe("ApprovalProjectionReadResponseSchema", () => {
  it("accepts a pending ask and a resolved one", () => {
    const reply = { approvals: [PENDING_ROW, RESOLVED_ROW] };
    expect(ApprovalProjectionReadResponseSchema.safeParse(reply).success).toBe(true);
  });

  it("refuses a resolved ask missing a resolved member, and a pending ask carrying one", () => {
    const { resolvedAt: _resolvedAt, ...resolvedWithoutTime } = RESOLVED_ROW;
    expect(
      ApprovalProjectionReadResponseSchema.safeParse({ approvals: [resolvedWithoutTime] }).success,
    ).toBe(false);
    expect(
      ApprovalProjectionReadResponseSchema.safeParse({
        approvals: [{ ...PENDING_ROW, decision: "approved" }],
      }).success,
    ).toBe(false);
  });

  it("refuses a decision other than the resolved state, and a rule whose sense disagrees", () => {
    expect(
      ApprovalProjectionReadResponseSchema.safeParse({
        approvals: [{ ...RESOLVED_ROW, decision: "rejected", rememberedScope: undefined }],
      }).success,
    ).toBe(false);
    expect(
      ApprovalProjectionReadResponseSchema.safeParse({
        approvals: [
          { ...RESOLVED_ROW, rememberedScope: { ...ALLOW_THIS_SESSION, sense: "block" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a rule on an ask that has not been answered", () => {
    expect(
      ApprovalProjectionReadResponseSchema.safeParse({
        approvals: [{ ...PENDING_ROW, rememberedScope: ALLOW_THIS_SESSION }],
      }).success,
    ).toBe(false);
  });

  it("refuses an expired state and an expiry member, because an ask never expires", () => {
    expect(
      ApprovalProjectionReadResponseSchema.safeParse({
        approvals: [{ ...PENDING_ROW, state: "expired" }],
      }).success,
    ).toBe(false);
    expect(
      ApprovalProjectionReadResponseSchema.safeParse({
        approvals: [{ ...PENDING_ROW, expiryAt: AT }],
      }).success,
    ).toBe(false);
  });
});

describe("RememberedRuleListResponseSchema", () => {
  const RULE = {
    ruleId: RULE_ID,
    category: "network_access",
    scope: { kind: "project", pattern: "api.example.com", sense: "block" },
    madeAtLevel: "reviewed",
    grantedAt: AT,
  };

  it("accepts a rule in force", () => {
    expect(RememberedRuleListResponseSchema.safeParse({ rules: [RULE] }).success).toBe(true);
  });

  it("refuses a rule made at a level that never asks", () => {
    expect(
      RememberedRuleListResponseSchema.safeParse({ rules: [{ ...RULE, madeAtLevel: "yolo" }] })
        .success,
    ).toBe(false);
  });
});

describe("RememberedRuleRevokeResponseSchema", () => {
  it("accepts an explicit revocation and refuses any other trigger", () => {
    const receipt = { ruleId: RULE_ID, revokedAt: AT, invalidationTrigger: "explicit" };
    expect(RememberedRuleRevokeResponseSchema.safeParse(receipt).success).toBe(true);
    expect(
      RememberedRuleRevokeResponseSchema.safeParse({
        ...receipt,
        invalidationTrigger: "session_end",
      }).success,
    ).toBe(false);
  });
});

describe("ApprovalDenialOverrideRequestSchema", () => {
  it("accepts a session and a denial and refuses a request naming no denial", () => {
    expect(
      ApprovalDenialOverrideRequestSchema.safeParse({ sessionId: SESSION_ID, denialId: DENIAL_ID })
        .success,
    ).toBe(true);
    expect(ApprovalDenialOverrideRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(
      false,
    );
  });
});

describe("approval event payloads", () => {
  const SHARED = {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    approvalRequestId: REQUEST_ID,
    category: "tool_execution",
    scope: "pnpm test",
  };

  it("refuses a resolution that does not echo the answering client", () => {
    const resolved = { ...SHARED, approver: USER_ID, effectiveScope: "pnpm test" };
    expect(
      ApprovalResolvedPayloadSchema.safeParse({ ...resolved, clientResolutionId: RESOLUTION_ID })
        .success,
    ).toBe(true);
    expect(ApprovalResolvedPayloadSchema.safeParse(resolved).success).toBe(false);
  });

  it("refuses a remembered rule missing the level it was made at", () => {
    const remembered = {
      ...SHARED,
      approver: USER_ID,
      nodeId: "node-1",
      ruleId: RULE_ID,
      rememberedScope: ALLOW_THIS_SESSION,
      madeAtLevel: "ask",
    };
    expect(ApprovalRememberedPayloadSchema.safeParse(remembered).success).toBe(true);
    const { madeAtLevel: _madeAtLevel, ...withoutLevel } = remembered;
    expect(ApprovalRememberedPayloadSchema.safeParse(withoutLevel).success).toBe(false);
  });

  it("accepts a reviewer's block and refuses one that does not say whether it can be overruled", () => {
    const denied = {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      agentId: USER_ID,
      denialId: DENIAL_ID,
      eventId: "event-7",
      reason: "[Data Exfiltration]",
      overridable: true,
    };
    expect(ApprovalReviewerDeniedPayloadSchema.safeParse(denied).success).toBe(true);
    const { overridable: _overridable, ...withoutFlag } = denied;
    expect(ApprovalReviewerDeniedPayloadSchema.safeParse(withoutFlag).success).toBe(false);
  });
});
