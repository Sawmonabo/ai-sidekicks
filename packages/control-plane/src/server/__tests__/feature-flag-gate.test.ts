// The feature-flag gate refuses unless `CONTROL_PLANE_BOOTSTRAP_ENABLED` is exactly '1', driven
// through `buildControlPlaneFetchHandler` with the environment gate pinned to 'development' so only
// the flag can refuse. The refusal log must name the flag, or a misconfigured dev instance gives a
// bare 503 with no hint of the missing variable.

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

describe("T1 / gate #1: feature-flag refusal", () => {
  it("refuses when CONTROL_PLANE_BOOTSTRAP_ENABLED is undefined (gate #2 passing)", async () => {
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
    // Strict equality: 'true', 'yes' and 'on' all refuse.
    const result = await runGate({
      CONTROL_PLANE_BOOTSTRAP_ENABLED: "true",
      ENVIRONMENT: "development",
    });
    expect(result.status).toBe(503);
    expect(result.logs[0]).toContain("CONTROL_PLANE_BOOTSTRAP_ENABLED");
  });

  it("does NOT refuse when CONTROL_PLANE_BOOTSTRAP_ENABLED is '1' AND ENVIRONMENT is 'development'", async () => {
    // With both gates passing, the request reaches `fetchRequestHandler`.
    const logs: string[] = [];
    const handler = buildControlPlaneFetchHandler({
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
