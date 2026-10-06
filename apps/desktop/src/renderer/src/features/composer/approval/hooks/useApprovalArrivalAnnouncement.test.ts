// What a screen reader hears when approvals arrive: one names its category, several are counted,
// and a card already seen is not announced again.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ApprovalProjectionRow } from "@ai-sidekicks/contracts/approval";

import { pendingRecord } from "../record.test-support.js";
import { useApprovalArrivalAnnouncement } from "./useApprovalArrivalAnnouncement.js";

const SECOND_APPROVAL_ID = "7a1c2d3e-4f50-4612-8734-a5b6c7d8e9f0";
const THIRD_APPROVAL_ID = "9c3e4f50-6172-4834-a956-c7d8e9f0a1b2";

describe("an approval's arrival, announced", () => {
  it("names one arrival's category and counts several arriving at once", () => {
    const cardRoot = { current: null };
    const { result, rerender } = renderHook(
      ({ pending }: { pending: readonly ApprovalProjectionRow[] }) =>
        useApprovalArrivalAnnouncement(pending, cardRoot),
      { initialProps: { pending: [pendingRecord()] } },
    );
    expect(result.current).toBe("Approval needed: Write to a file.");

    rerender({
      pending: [
        pendingRecord(),
        pendingRecord({ id: SECOND_APPROVAL_ID, category: "network_access" }),
        pendingRecord({ id: THIRD_APPROVAL_ID }),
      ],
    });
    expect(result.current).toBe("2 approvals needed.");
  });
});
