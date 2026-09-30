// The pending ask every approval suite starts from, parsed through the contract's row
// schema so no suite asserts against a row the daemon could not send.

import {
  ApprovalProjectionRowSchema,
  ApprovalResolveRequestSchema,
  type ApprovalProjectionRow,
  type ApprovalResolveRequest,
} from "@ai-sidekicks/contracts";

/** The pending ask's id, for the cases that name it. */
export const PENDING_APPROVAL_ID = "3f6b1c2d-4e5f-4061-8273-9a4b5c6d7e8f";

/** One ask waiting on a decision, with the members named in `overrides` replaced. */
export function pendingRecord(
  overrides: Readonly<Record<string, unknown>> = {},
): ApprovalProjectionRow {
  return ApprovalProjectionRowSchema.parse({
    id: PENDING_APPROVAL_ID,
    runId: "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061",
    requestedBy: "019b7a33-3300-7a6e-8110-d1a4c1150501",
    category: "file_write",
    scope: "session",
    resourceDescriptor: { path: "packages/contracts/src/approval.ts" },
    subject: "approval.ts",
    standingAllowOffered: true,
    state: "pending",
    createdAt: "2026-01-01T13:30:00.900Z",
    updatedAt: "2026-01-01T13:30:00.900Z",
    ...overrides,
  });
}

/** Whether the daemon would take this answer as sent: the contract's own parse. */
export function isAcceptedAnswer(request: ApprovalResolveRequest | undefined): boolean {
  return ApprovalResolveRequestSchema.safeParse(request).success;
}
