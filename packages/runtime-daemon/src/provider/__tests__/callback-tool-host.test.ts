// Callback-tool host: every tool call is answered, nothing runs without the approval seam's allow,
// and a registry answers only for the spawn that installed it.

import { describe, expect, it } from "vitest";

import type { CallbackToolInvocation } from "../driver/provider-driver.js";
import {
  bindSpawn,
  buildCallbackToolHostHarness,
  searchSpawnRequest,
  SEARCH_TOOL,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "./callback-tool-host.test-support.js";

function makeInvocation(overrides?: Partial<CallbackToolInvocation>): CallbackToolInvocation {
  return {
    toolName: SEARCH_TOOL.name,
    arguments: { query: "needle" },
    toolCallId: "call-1",
    sessionId: TEST_SESSION_ID,
    runId: TEST_RUN_ID,
    ...overrides,
  };
}

describe("CallbackToolHost — the allow round-trip", () => {
  it("answers `completed` and lands the outcome as a `tool_activity` row", async () => {
    const harness = buildCallbackToolHostHarness();
    const resolution = harness.host.resolveSpawnRegistry(searchSpawnRequest());
    expect(resolution.admitted).toBe(true);
    expect(resolution.admitted ? resolution.tools : null).toStrictEqual([SEARCH_TOOL]);

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result).toStrictEqual({ status: "completed", output: { hits: 0 } });
    // The pipeline ran before the executor, so no call completes without a policy decision.
    expect(harness.evaluatedRequests).toHaveLength(1);
    expect(harness.evaluatedRequests[0]?.arguments).toStrictEqual({ query: "needle" });
    expect(harness.executedInvocations).toHaveLength(1);
    expect(harness.activityRecords).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        toolName: SEARCH_TOOL.name,
        toolCallId: "call-1",
        disposition: "completed",
        approvalBasis: "policy",
      },
    ]);
  });
});

describe("CallbackToolHost — the deny round-trip", () => {
  it("answers `denied` without executing, and lands it as a `tool_activity` row", async () => {
    const harness = buildCallbackToolHostHarness({
      outcome: { decision: "deny", basis: "policy", reason: "workspace search is not permitted" },
    });
    harness.host.resolveSpawnRegistry(searchSpawnRequest());

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result).toStrictEqual({
      status: "denied",
      error: "workspace search is not permitted",
    });
    expect(harness.executedInvocations).toHaveLength(0);
    expect(harness.activityRecords).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        toolName: SEARCH_TOOL.name,
        toolCallId: "call-1",
        disposition: "denied-by-policy",
        approvalBasis: "policy",
      },
    ]);
  });
});

describe("CallbackToolHost — the no-seam spawn and the stray invocation", () => {
  it("withholds the registry at spawn and records why", () => {
    const harness = buildCallbackToolHostHarness({ withSeam: false });

    const resolution = harness.host.resolveSpawnRegistry(searchSpawnRequest());

    expect(harness.host.canAdjudicate).toBe(false);
    expect(resolution.admitted).toBe(false);
    expect(resolution.admitted === false ? resolution.reason : undefined).toBe("no-approval-seam");
    const withholdings = harness.diagnostics.recentRecordsOfKind("callback_tool_registry_withheld");
    expect(withholdings).toHaveLength(1);
    expect(withholdings[0]?.details["withheldToolCount"]).toBe(1);
  });

  it("answers a stray invocation `denied` with a diagnostic, never `completed`", async () => {
    // The provider carries a registration this daemon never performed, so the call arrives anyway.
    const harness = buildCallbackToolHostHarness({ withSeam: false });
    harness.host.resolveSpawnRegistry(searchSpawnRequest());

    const result = await harness.host.dispatch(makeInvocation(), null);

    // `denied`, not `failed`: the call is well-formed and the daemon is the one refusing it.
    expect(result.status).toBe("denied");
    expect(harness.executedInvocations).toHaveLength(0);
    expect(harness.diagnostics.recentRecordsOfKind("callback_tool_seam_absent")).toHaveLength(1);
    expect(harness.activityRecords[0]?.disposition).toBe("denied-no-seam");
    expect(harness.activityRecords[0]?.approvalBasis).toBeNull();
  });
});

describe("CallbackToolHost — refusals that precede the pipeline", () => {
  it("refuses an unknown tool name WITHOUT consulting the seam", async () => {
    const harness = buildCallbackToolHostHarness();
    harness.host.resolveSpawnRegistry(searchSpawnRequest());

    const result = await harness.host.dispatch(
      makeInvocation({ toolName: "delete_everything" }),
      null,
    );

    expect(result.status).toBe("failed");
    expect(harness.evaluatedRequests).toHaveLength(0);
    expect(harness.activityRecords[0]?.disposition).toBe("failed-unknown-tool");
  });

  it("refuses schema-invalid arguments WITHOUT consulting the seam", async () => {
    const harness = buildCallbackToolHostHarness();
    harness.host.resolveSpawnRegistry(searchSpawnRequest());

    const result = await harness.host.dispatch(makeInvocation({ arguments: {} }), null);

    expect(result.status).toBe("failed");
    expect(harness.evaluatedRequests).toHaveLength(0);
    expect(harness.activityRecords[0]?.disposition).toBe("failed-invalid-arguments");
  });
});

describe("CallbackToolHost — execution outcomes are the tool's, not the pipeline's", () => {
  it("records an executor throw as an allowed row that failed, never as a refusal", async () => {
    const harness = buildCallbackToolHostHarness({
      executeThrows: new Error("the workspace mount vanished"),
    });
    harness.host.resolveSpawnRegistry(searchSpawnRequest());

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result).toStrictEqual({ status: "failed", error: "the workspace mount vanished" });
    expect(harness.activityRecords[0]?.disposition).toBe("failed-in-execution");
    // The invocation was adjudicated, so the row keeps its basis instead of reading as a refusal.
    expect(harness.activityRecords[0]?.approvalBasis).toBe("policy");
  });

  it("refuses when the approval seam THROWS, rather than completing unadjudicated", async () => {
    const harness = buildCallbackToolHostHarness({
      evaluateThrows: new Error("the policy store is unreachable"),
    });
    harness.host.resolveSpawnRegistry(searchSpawnRequest());

    const result = await harness.host.dispatch(makeInvocation(), null);

    // A rejected evaluation is an unanswered one: letting it escape would read as a driver fault
    // the provider retries, and proceeding would run the tool unadjudicated. Refusing matches the
    // missing-seam answer.
    expect(result.status).toBe("denied");
    expect(harness.executedInvocations).toStrictEqual([]);
    expect(harness.activityRecords[0]?.disposition).toBe("denied-no-seam");
    expect(harness.diagnostics.recentRecordsOfKind("callback_tool_seam_absent")).toHaveLength(1);
    // The cause travels so the person can tell an absent seam from a failing one.
    expect(result.error).toContain("the policy store is unreachable");
  });
});

describe("bindCallbackToolsForSpawn — release", () => {
  it("releases the session's registry, so a later invocation names no registry", async () => {
    const harness = buildCallbackToolHostHarness();
    const binding = bindSpawn(harness);

    binding.release();
    // A teardown path that runs twice must not throw.
    binding.release();

    const result = await binding.onCallbackToolCall(makeInvocation());
    expect(result).toStrictEqual({
      status: "failed",
      error: "invocation names a session with no registered callback-tool registry",
    });
  });
});

describe("CallbackToolHost — the registry is scoped to the spawn that installed it", () => {
  // A resume or relaunch installs a new registry for the same session before the superseded
  // spawn's teardown runs. Without a per-binding token, the old `release()` would delete the new
  // registry and the old process's callbacks would be adjudicated against the replacement.
  it("makes a superseded binding's release a no-op, recorded rather than silent", async () => {
    const harness = buildCallbackToolHostHarness();
    const supersededBinding = bindSpawn(harness);
    const liveBinding = bindSpawn(harness);

    supersededBinding.release();

    // The live binding still dispatches: the old teardown did not delete its registry.
    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    expect(harness.emittedDiagnostics.map((record) => record.kind)).toStrictEqual([
      // The supersession, then the ignored release.
      "callback_tool_registry_superseded",
      "callback_tool_registry_release_ignored",
    ]);
  });

  it(
    "refuses a superseded binding's dispatch rather than adjudicating it against the live " +
      "registry",
    async () => {
      const harness = buildCallbackToolHostHarness();
      const supersededBinding = bindSpawn(harness);
      bindSpawn(harness);

      const result = await supersededBinding.onCallbackToolCall(makeInvocation());

      expect(result.status).toBe("failed");
      // A same-named tool in the replacement registry must not carry a dead process's call into
      // the live spawn's approval seam.
      expect(harness.evaluatedRequests).toStrictEqual([]);
      expect(harness.executedInvocations).toStrictEqual([]);
      expect(harness.activityRecords[0]?.disposition).toBe("failed-superseded-binding");
    },
  );
});

describe("CallbackToolHost — a failed replacement spawn rolls its registry back", () => {
  // Installing a replacement before its spawn means a failed resume has already superseded a
  // predecessor that a resume path deliberately leaves alive. `release()` would delete only
  // the replacement, and the surviving process would then dispatch against an absent registry and
  // be refused on every later call.
  it("restores the predecessor's registry so the surviving process still dispatches", async () => {
    const harness = buildCallbackToolHostHarness();
    const liveBinding = bindSpawn(harness);
    const failedReplacement = bindSpawn(harness, [{ ...SEARCH_TOOL, name: "read_workspace" }]);

    failedReplacement.rollback();

    // The predecessor's own token addresses the restored registry again; its closure holds
    // nothing else.
    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    // The restore is a registry replacement like any other and is recorded as one.
    expect(harness.emittedDiagnostics.map((record) => record.kind)).toStrictEqual([
      "callback_tool_registry_superseded",
      "callback_tool_registry_superseded",
    ]);
    expect(harness.emittedDiagnostics[1]?.dispositionReason).toContain("rolled");
    expect(harness.emittedDiagnostics[1]?.details["installedInstallation"]).toBe(
      harness.emittedDiagnostics[0]?.details["supersededInstallation"],
    );
  });

  it("ignores a rollback whose installation a THIRD spawn already superseded", async () => {
    // Undoing here would tear down a live registry to restore a dead one; it is recorded as an
    // ignored release, like a late release.
    const harness = buildCallbackToolHostHarness();
    bindSpawn(harness);
    const middleBinding = bindSpawn(harness);
    const liveBinding = bindSpawn(harness);

    middleBinding.rollback();

    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    expect(harness.emittedDiagnostics.map((record) => record.kind)).toStrictEqual([
      "callback_tool_registry_superseded",
      "callback_tool_registry_superseded",
      "callback_tool_registry_release_ignored",
    ]);
  });
});
