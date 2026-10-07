// The two request gates, driven through `buildControlPlaneFetchHandler`. The feature flag must be
// exactly '1' and `ENVIRONMENT` exactly 'development'; each block pins the other gate to its
// passing value so only the gate under test can refuse. A refusal log names the key, or a
// misconfigured dev instance gives a bare 503 with no hint of the missing variable.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { DevEnvironmentEnv } from "../dev-environment-gate.js";
import type { FeatureFlagEnv } from "../feature-flag-gate.js";
import { buildControlPlaneFetchHandler } from "../host.js";

// What the two gates read; each run adds the Worker's own counter binding.
type GateEnv = FeatureFlagEnv & DevEnvironmentEnv;

interface HarnessResult {
  readonly status: number;
  readonly body: string;
  readonly logs: readonly string[];
}

async function runGate(gateEnv: GateEnv): Promise<HarnessResult> {
  const logs: string[] = [];
  const handler = buildControlPlaneFetchHandler({
    refusalLogger: (msg) => logs.push(msg),
    requestIdGenerator: () => "req-test-1",
  });
  const response = await handler(new Request("https://control-plane.test/trpc/unknown.procedure"), {
    ...gateEnv,
    RATE_LIMIT_IDENTITY: env.RATE_LIMIT_IDENTITY,
  });
  return {
    status: response.status,
    body: await response.text(),
    logs,
  };
}

describe("feature-flag gate", () => {
  it("refuses when CONTROL_PLANE_BOOTSTRAP_ENABLED is undefined", async () => {
    const result = await runGate({ ENVIRONMENT: "development" });
    expect(result.status).toBe(503);
    expect(result.body).toBe("Service Unavailable");
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toContain("CONTROL_PLANE_BOOTSTRAP_ENABLED");
  });

  it("refuses when CONTROL_PLANE_BOOTSTRAP_ENABLED is 'true' (only '1' passes)", async () => {
    // Strict equality: 'true', 'yes' and 'on' all refuse.
    const result = await runGate({
      CONTROL_PLANE_BOOTSTRAP_ENABLED: "true",
      ENVIRONMENT: "development",
    });
    expect(result.status).toBe(503);
    expect(result.logs[0]).toContain("CONTROL_PLANE_BOOTSTRAP_ENABLED");
  });
});

interface RefusalRow {
  readonly label: string;
  readonly env: GateEnv;
}

// Each row pins the feature flag to its passing value so the environment gate is the sole driver.
// The undefined row is the default deploy: `wrangler deploy` with no `--env` has no `ENVIRONMENT`,
// even after someone sets the feature flag as a secret.
const REFUSAL_ROWS: readonly RefusalRow[] = [
  {
    label: "ENVIRONMENT undefined (a default deploy)",
    env: { CONTROL_PLANE_BOOTSTRAP_ENABLED: "1" },
  },
  {
    label: "ENVIRONMENT='production'",
    env: { CONTROL_PLANE_BOOTSTRAP_ENABLED: "1", ENVIRONMENT: "production" },
  },
];

describe("environment gate: an allow-list of 'development'", () => {
  for (const row of REFUSAL_ROWS) {
    it(`refuses ${row.label}`, async () => {
      const result = await runGate(row.env);
      expect(result.status).toBe(503);
      expect(result.body).toBe("Service Unavailable");
      expect(result.logs).toHaveLength(1);
      // The log names the key and the only passing value, so the person reading it needs no source.
      expect(result.logs[0]).toContain("ENVIRONMENT");
      expect(result.logs[0]).toContain("'development'");
    });
  }
});

describe("both gates passing", () => {
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
