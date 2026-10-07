// The mount every approval-card suite starts from.

import type {
  ApprovalProjectionRow,
  ApprovalResolveRequest,
} from "@ai-sidekicks/contracts/approval";
import { render } from "@testing-library/react";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";

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
    // A refused answer speaks through the announcer, which throws outside its provider.
    { wrapper: LiveAnnouncerProvider },
  );
  return requests;
}
