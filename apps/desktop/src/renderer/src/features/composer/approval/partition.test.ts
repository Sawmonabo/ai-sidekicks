import { describe, expect, it } from "vitest";

import { partitionApprovalRecords } from "./partition.js";
import { pendingRecord } from "./approval-record.test-support.js";

const FIRST = "019b7a33-3300-7f01-8110-d1a4c11505a1";
const SECOND = "019b7a33-3300-7f01-8110-d1a4c11505a2";
const THIRD = "019b7a33-3300-7f01-8110-d1a4c11505a3";

describe("partitionApprovalRecords — one answered read, split in two", () => {
  it("puts every returned record in exactly one list", () => {
    const partitioned = partitionApprovalRecords({
      status: "answered",
      rows: [
        pendingRecord({ id: FIRST }),
        pendingRecord({ id: SECOND, state: "canceled" }),
        pendingRecord({ id: THIRD }),
      ],
      unreadableCount: 0,
    });
    expect(partitioned.pending.map((row) => row.id)).toStrictEqual([FIRST, THIRD]);
    expect(partitioned.history.map((row) => row.id)).toStrictEqual([SECOND]);
  });
});
