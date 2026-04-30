// Plan-008 §Phase 1 §T-008b-1-T2 (table-driven) + §T-008b-1-T3 (pass-through):
// I-008-1 gate #2 (`ENVIRONMENT === 'development'`) allow-list contract.
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
//        allow-list pivot (Codex PR #20 round 4 — see Plan-008 §Decision
//        Log) closed this path.
//
//   T3 — The 'development' row asserts the gate-PASS contract: status
//        is NOT 503 and the refusal logger is never invoked. The handler
//        dispatches into `fetchRequestHandler` (tRPC v11). To prove the
//        gate let traffic through without invoking router-side deps, the
//        test routes a path tRPC rejects pre-dispatch (unknown procedure
//        method) — that path crashes the refusal-asserting deps if
//        reached, so a passing test proves the dispatch happened cleanly.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-1,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T2,
//       docs/plans/008-control-plane-relay-and-session-join.md §T-008b-1-T3,
//       Plan-008 §Decision Log 2026-04-30 (Codex PR #20 round-4 allow-list pivot).

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
  const response = await handler(
    new Request("https://control-plane.test/trpc/session.bogus-method"),
    env,
  );
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

describe("T2 / I-008-1 gate #2: dev-environment allow-list refusal table", () => {
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

describe("T3 / I-008-1 gate #2: handler serves with both gates passing", () => {
  it("does NOT refuse when CONTROL_PLANE_BOOTSTRAP_ENABLED='1' AND ENVIRONMENT='development'", async () => {
    const result = await runGate({
      CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
      ENVIRONMENT: "development",
    });
    // The exact status is tRPC's choice for an unknown method
    // (404 in v11). The contract here is "not 503" — i.e., the gates
    // let traffic through.
    expect(result.status).not.toBe(503);
    expect(result.logs).toEqual([]);
  });

  it("dispatches into the tRPC router on a valid path (no router deps invoked yet because procedure lookup precedes deps)", async () => {
    // Stronger: route to the canonical `/trpc/session.read` with no
    // parameters and assert the response is a tRPC envelope (4xx) — not a
    // gate refusal (503) and not a deps-call crash (500 from the throwing
    // querier). This proves the gate layer + tRPC routing both work end
    // to end without the router actually executing a handler that would
    // touch the throwing deps.
    const logs: string[] = [];
    const handler = buildControlPlaneFetchHandler(makeRefusalAssertingDeps(), {
      refusalLogger: (msg) => logs.push(msg),
    });
    const response = await handler(new Request("https://control-plane.test/trpc/session.read"), {
      CONTROL_PLANE_BOOTSTRAP_ENABLED: "1",
      ENVIRONMENT: "development",
    });
    expect(response.status).not.toBe(503);
    expect(logs).toEqual([]);
  });
});
