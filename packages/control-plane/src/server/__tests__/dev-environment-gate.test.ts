// The control-plane fetch handler's gate #2 (`ENVIRONMENT === 'development'`)
// allow-list contract.
//
// What we verify, end-to-end through `buildControlPlaneFetchHandler`:
//
//   T2 — Refusal table (gate #2 fails for every value other than the
//        canonical 'development'). Each refusal returns HTTP 503 + body
//        "Service Unavailable" + a logger message that names the
//        `ENVIRONMENT` key + cites the only passing value
//        ('development'). Gate #1 is pinned to its passing value ('1') so
//        gate #2 is isolated.
//
//        The 'undefined' row exercises the default-deploy threat path: a
//        Worker published via `wrangler deploy` (no `--env`) has
//        `env.ENVIRONMENT === undefined`, even after a hypothetical
//        `wrangler secret put CONTROL_PLANE_BOOTSTRAP_ENABLED 1`. The
//        allow-list closes this path.
//
//   T3 — The 'development' row asserts the gate-PASS contract: the request
//        reaches the tRPC router, which answers a path it does not serve with
//        404, and the refusal logger is never invoked.
//

import { describe, expect, it } from "vitest";
import { buildControlPlaneFetchHandler, type ControlPlaneEnv } from "../host.js";

interface HarnessResult {
  readonly status: number;
  readonly body: string;
  readonly logs: readonly string[];
}

async function runGate(env: ControlPlaneEnv): Promise<HarnessResult> {
  const logs: string[] = [];
  const handler = buildControlPlaneFetchHandler({
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

interface RefusalRow {
  readonly label: string;
  readonly env: ControlPlaneEnv;
}

// Each row pins gate #1 to its passing value so gate #2 is the sole driver.
const REFUSAL_ROWS: readonly RefusalRow[] = [
  {
    label: "ENVIRONMENT undefined (default-deploy threat path)",
    env: { CONTROL_PLANE_BOOTSTRAP_ENABLED: "1" },
  },
  {
    label: "ENVIRONMENT='production'",
    env: { CONTROL_PLANE_BOOTSTRAP_ENABLED: "1", ENVIRONMENT: "production" },
  },
  {
    label: "ENVIRONMENT='staging'",
    env: { CONTROL_PLANE_BOOTSTRAP_ENABLED: "1", ENVIRONMENT: "staging" },
  },
  {
    label: "ENVIRONMENT='test'",
    env: { CONTROL_PLANE_BOOTSTRAP_ENABLED: "1", ENVIRONMENT: "test" },
  },
  {
    label: "ENVIRONMENT='' (empty string)",
    env: { CONTROL_PLANE_BOOTSTRAP_ENABLED: "1", ENVIRONMENT: "" },
  },
];

describe("T2 / gate #2: dev-environment allow-list refusal table", () => {
  for (const row of REFUSAL_ROWS) {
    it(`refuses ${row.label}`, async () => {
      const result = await runGate(row.env);
      expect(result.status).toBe(503);
      expect(result.body).toBe("Service Unavailable");
      expect(result.logs).toHaveLength(1);
      // The log message must mention the ENVIRONMENT key + the canonical
      // passing value so an operator can diagnose without consulting source.
      expect(result.logs[0]).toContain("ENVIRONMENT");
      expect(result.logs[0]).toContain("'development'");
    });
  }
});

describe("T3 / gate #2: handler serves with both gates passing", () => {
  it("does NOT refuse when both gates pass", async () => {
    const result = await runGate({
      CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
      ENVIRONMENT: "development",
    });
    // Past both gates the request reaches the tRPC router, which turns away a
    // procedure it does not serve with 404 NOT_FOUND: proof the gates let the
    // request through rather than answering it themselves.
    expect(result.status).toBe(404);
    expect(result.body).toContain("NOT_FOUND");
    expect(result.logs).toEqual([]);
  });
});
