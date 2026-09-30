// The check rollup is worst-first: one failure among passes reads red.

import { describe, expect, it } from "vitest";

import type { ChangeRequestCheck } from "@ai-sidekicks/contracts";

import { checkRollup } from "./hosting-status.js";

describe("checkRollup — worst-first", () => {
  const checks: readonly Pick<ChangeRequestCheck, "name" | "status">[] = [
    { name: "lint", status: "success" },
    { name: "typecheck", status: "success" },
    { name: "test", status: "pending" },
  ];

  it("goes red on one failure among many passes", () => {
    const rollup = checkRollup([...checks, { name: "e2e", status: "failure" }]);
    expect(rollup.tone).toBe("failure");
    expect(rollup.countByStatus.failure).toBe(1);
  });
});
