// The mount every approval-card suite starts from.
//
// Not a test file — no `include` glob reaches a `.test-support.tsx`. It exists because
// the card's claims split across two suites the moment the settled-refusal withdrawal
// grew its own, and `apps/desktop` AGENTS.md hoists a helper on its second use.

import type { ApprovalProjectionRow, ApprovalResolveRequest } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";

import { ApprovalCard } from "./ApprovalCard.js";
import { type Refusal } from "@renderer/lib/refusal.js";

/**
 * Mount one card and collect what its REAL `onResolve` was called with.
 *
 * The requests are the component's own, never a re-derivation beside it: what a
 * suite checks is the payload that would go on the wire.
 */
export function renderCard(
  record: ApprovalProjectionRow,
  isResolving = false,
  refusal: Refusal | undefined = undefined,
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
