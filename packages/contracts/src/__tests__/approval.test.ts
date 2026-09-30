// The approval answer and the card's rows: an answer's remembered rule, decline text and edited
// action agree with its decision, a row's resolved members, decision and rule agree with its
// state, and a rule is made only at a level that asks, so an answer never means something the
// person did not press.
import { describe, expect, it } from "vitest";

import {
  ApprovalProjectionReadResponseSchema,
  ApprovalResolveRequestSchema,
  RememberedRuleListResponseSchema,
} from "../approval.js";

const RUN_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const REQUEST_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RULE_ID = "1f2b4d5e-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "2f2b4d5e-cccc-4ccc-8ccc-cccccccccccc";
const RESOLUTION_ID = "3f2b4d5e-dddd-4ddd-8ddd-dddddddddddd";
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
