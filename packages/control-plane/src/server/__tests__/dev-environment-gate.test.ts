// The environment gate refuses every `ENVIRONMENT` value except 'development', driven through
// `buildControlPlaneFetchHandler`. The undefined row is the default-deploy case: a Worker published
// with `wrangler deploy` and no `--env` has no `ENVIRONMENT`, even after someone sets the feature
// flag as a secret. The feature flag is pinned to '1' throughout so only this gate can refuse.

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

// Each row pins the feature flag to its passing value so the environment gate is the sole driver.
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
      // The log names the key and the only passing value, so an operator needs no source.
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
    // A 404 NOT_FOUND from the tRPC router shows the gates let the request through.
    expect(result.status).toBe(404);
    expect(result.body).toContain("NOT_FOUND");
    expect(result.logs).toEqual([]);
  });
});
