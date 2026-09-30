// The check rollup is worst-first and a running check needs nobody; the empty list is the
// control that must not read red.

import { describe, expect, it } from "vitest";

import type { ChangeRequestCheck } from "@ai-sidekicks/contracts";

import { checkRollup } from "./hosting-status.js";

describe("checkRollup — worst-first, and pending needs nobody", () => {
  const checks: readonly Pick<ChangeRequestCheck, "name" | "status">[] = [
    { name: "lint", status: "success" },
    { name: "typecheck", status: "success" },
    { name: "test", status: "pending" },
  ];

  it("counts each status and totals the list", () => {
    const rollup = checkRollup(checks);
    expect(rollup.countByStatus).toStrictEqual({ pending: 1, success: 2, failure: 0 });
    expect(rollup.total).toBe(3);
  });

  it("stays neutral while a check is merely still running", () => {
    expect(checkRollup(checks).tone).toBe("neutral");
  });

  it("goes red on one failure among many passes", () => {
    const rollup = checkRollup([...checks, { name: "e2e", status: "failure" }]);
    expect(rollup.tone).toBe("failure");
    expect(rollup.countByStatus.failure).toBe(1);
  });

  it("negative control: an empty list is neutral and totals zero, never red", () => {
    // A rollup that defaulted to `failure` would look right on every failing case and be wrong
    // for every proposal with no checks.
    const rollup = checkRollup([]);
    expect(rollup.tone).toBe("neutral");
    expect(rollup.total).toBe(0);
    expect(rollup.countByStatus).toStrictEqual({ pending: 0, success: 0, failure: 0 });
  });
});
