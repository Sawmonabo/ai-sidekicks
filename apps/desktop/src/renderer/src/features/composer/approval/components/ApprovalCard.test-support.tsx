// The mount every approval-card suite starts from.

import type {
  ApprovalProjectionRow,
  ApprovalResolveRequest,
} from "@ai-sidekicks/contracts/approval";
import { render } from "@testing-library/react";

import { ApprovalCard } from "./ApprovalCard.js";
import { type Refusal } from "@renderer/lib/refusal.js";

/** Mounts one card and returns the requests its real `onResolve` receives. */
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
