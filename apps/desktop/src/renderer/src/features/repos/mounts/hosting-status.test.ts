// The check rollup, held against the rule it was written from: worst-first, and a check
// that is still running needs nobody. Each clean case is paired with the one that would
// pass if the fold stopped doing the thing — a worst-first rollup is only meaningful beside
// the empty list that must not read red.

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
    // Without this, a rollup that defaulted to `failure` would look correct on every
    // failing case above and be wrong on every proposal with no checks configured.
    const rollup = checkRollup([]);
    expect(rollup.tone).toBe("neutral");
    expect(rollup.total).toBe(0);
    expect(rollup.countByStatus).toStrictEqual({ pending: 0, success: 0, failure: 0 });
  });
});
