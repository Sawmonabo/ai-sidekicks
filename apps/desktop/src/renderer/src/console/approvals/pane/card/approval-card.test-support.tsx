// The record and the mount every approval-card suite starts from.
//
// Not a test file — no `include` glob reaches a `.test-support.tsx`. It exists
// because the card's claims split across two suites the moment the settled-refusal
// withdrawal grew its own, and `apps/desktop` AGENTS.md hoists a helper on its
// second use: two copies of "a pending record" is how one suite comes to assert
// against a record the other no longer builds.

import { render } from "@testing-library/react";

import { ApprovalCard } from "./ApprovalCard.js";
import { type ConsoleRefusal } from "../../../core/index.js";
import { type ApprovalRecord } from "../../../bridge/index.js";
import { type ApprovalResolveRequest } from "../approvals-wire.js";

/** One record waiting on a decision, with every member the card reads. */
export function pendingRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalRequestId: "approval-01",
    runId: "run-01",
    category: "file_write",
    state: "pending",
    requestedBy: "agent-implementer",
    requestedScope: "session",
    resourceDescriptor: { path: "packages/contracts/src/approval.ts" },
    createdAt: "2026-01-01T13:30:00.900Z",
    updatedAt: "2026-01-01T13:30:00.900Z",
    ...overrides,
  };
}

/**
 * Mount one card and collect what its REAL `onResolve` was called with.
 *
 * The requests are the component's own, never a re-derivation beside it: what a
 * suite checks is the payload that would go on the wire.
 */
export function renderCard(
  record: ApprovalRecord,
  isResolving = false,
  refusal: ConsoleRefusal | undefined = undefined,
): ApprovalResolveRequest[] {
  const requests: ApprovalResolveRequest[] = [];
  render(
    <ApprovalCard
      record={record}
      isResolving={isResolving}
      refusal={refusal}
      onResolve={(request) => requests.push(request)}
    />,
  );
  return requests;
}
