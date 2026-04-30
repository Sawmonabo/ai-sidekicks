// Plan-008 §Phase 1 §T-008b-1-T1: I-008-1 gate #1
// (`CONTROL_PLANE_BOOTSTRAP_ENABLED === '1'`) refusal contract.
//
// What we verify, end-to-end through `buildControlPlaneFetchHandler`:
//
//   1. The handler refuses with HTTP 503 + body "Service Unavailable" when
//      gate #1 fails — even when gate #2 (`ENVIRONMENT === 'development'`)
//      would pass on its own. This isolates gate #1's contribution by
//      pinning gate #2 to its passing value.
//
//   2. The refusal logger receives a message that names the
//      `CONTROL_PLANE_BOOTSTRAP_ENABLED` key (operator-facing
//      diagnostic — without it, a misconfigured dev instance gives a
//      generic 503 with no breadcrumb to the missing env var).
//
//   3. No router-side dependency is reached on a refusal path. The
//      `makeRefusalAssertingDeps()` fixture throws on every dep call, so
//      a passing refusal test proves the gate intercepted BEFORE
//      `fetchRequestHandler` dispatch — not just that the response came
//      back as 503 for some other reason.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-1,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T1.

import { describe, expect, it } from "vitest";
import { buildControlPlaneFetchHandler, type ControlPlaneEnv } from "../host.js";
import { makeRefusalAssertingDeps } from "./_helpers.js";

interface HarnessResult {
  readonly status: number;
  readonly body: string;
  readonly logs: readonly string[];
}

async function runGate(env: ControlPlaneEnv): Promise<HarnessResult> {
  const logs: string[] = [];
  const handler = buildControlPlaneFetchHandler(makeRefusalAssertingDeps(), {
    refusalLogger: (msg) => logs.push(msg),
    requestIdGenerator: () => "req-test-1",
  });
  const response = await handler(new Request("https://control-plane.test/trpc/session.read"), env);
  return {
    status: response.status,
    body: await response.text(),
    logs,
  };
}

describe("T1 / I-008-1 gate #1: feature-flag refusal", () => {
  it("refuses when CONTROL_PLANE_BOOTSTRAP_ENABLED is undefined (gate #2 passing)", async () => {
    // Gate #2 is pinned to its allow-list value to isolate gate #1's
    // contribution — only the missing flag should drive the refusal.
    const result = await runGate({ ENVIRONMENT: "development" });
    expect(result.status).toBe(503);
    expect(result.body).toBe("Service Unavailable");
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toContain("CONTROL_PLANE_BOOTSTRAP_ENABLED");
  });

  it("refuses when CONTROL_PLANE_BOOTSTRAP_ENABLED is '0' (gate #2 passing)", async () => {
    const result = await runGate({
      CONTROL_PLANE_BOOTSTRAP_ENABLED: "0",
      ENVIRONMENT: "development",
    });
    expect(result.status).toBe(503);
    expect(result.logs[0]).toContain("CONTROL_PLANE_BOOTSTRAP_ENABLED");
  });

  it("refuses when CONTROL_PLANE_BOOTSTRAP_ENABLED is empty string (gate #2 passing)", async () => {
    const result = await runGate({
      CONTROL_PLANE_BOOTSTRAP_ENABLED: "",
      ENVIRONMENT: "development",
    });
    expect(result.status).toBe(503);
    expect(result.logs[0]).toContain("CONTROL_PLANE_BOOTSTRAP_ENABLED");
  });

  it("refuses when CONTROL_PLANE_BOOTSTRAP_ENABLED is 'true' (only literal '1' passes)", async () => {
    // Documents the strict-equality semantics — operator typos like 'true',
    // 'yes', 'on' all refuse. The flag is a single canonical pass-value.
    const result = await runGate({
      CONTROL_PLANE_BOOTSTRAP_ENABLED: "true",
      ENVIRONMENT: "development",
    });
    expect(result.status).toBe(503);
    expect(result.logs[0]).toContain("CONTROL_PLANE_BOOTSTRAP_ENABLED");
  });

  it("does NOT refuse when CONTROL_PLANE_BOOTSTRAP_ENABLED is '1' AND ENVIRONMENT is 'development'", async () => {
    // Sanity-check the inverse: with both gates passing the request leaves
    // the gate layer and reaches `fetchRequestHandler`. The refusal-asserting
    // deps would CRASH on any subsequent router dispatch, so we hit a path
    // tRPC rejects pre-dispatch (404 for an unknown procedure) — proving
    // the refusal layer let traffic through without invoking router deps.
    const logs: string[] = [];
    const handler = buildControlPlaneFetchHandler(makeRefusalAssertingDeps(), {
      refusalLogger: (msg) => logs.push(msg),
    });
    const response = await handler(
      new Request("https://control-plane.test/trpc/session.bogus-method"),
      { CONTROL_PLANE_BOOTSTRAP_ENABLED: "1", ENVIRONMENT: "development" },
    );
    expect(response.status).not.toBe(503);
    expect(logs).toEqual([]);
  });
});
