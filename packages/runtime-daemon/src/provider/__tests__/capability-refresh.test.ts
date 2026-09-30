// The CLI-version parse, which fails closed on anything short of a full semver, and the
// CapabilityRefreshScheduler, which pairs the capability refresh with the auth probe and keeps a
// failed, hung or stale-lifetime leg from stopping the poll or writing the wrong auth state.

import type { DriverAuthProbeResult } from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DriverDiagnosticsEmitter } from "../driver-diagnostics.js";
import type { DeclareDriverCapabilitiesResult } from "../driver-capabilities-writer.js";
import {
  CAPABILITY_REFRESH_INTERVAL_MS,
  CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS,
  CapabilityRefreshScheduler,
  DRIVER_CLI_VERSION_FLOORS,
  DriverCliVersionBelowFloorError,
  DriverCliVersionUnparseableError,
  parseCliVersionReport,
  type CapabilityRefreshDiagnostic,
  type CapabilityRefreshDriverEntry,
  type FlooredDriverName,
} from "../capability-refresh.js";

describe("parseCliVersionReport", () => {
  it("derives the canonical semver from a prose-wrapped raw string, preserving raw verbatim", () => {
    const report = parseCliVersionReport("codex", "codex-cli 0.149.1 (build abc123)");
    expect(report).toStrictEqual({ raw: "codex-cli 0.149.1 (build abc123)", semver: "0.149.1" });

    const claudeReport = parseCliVersionReport("claude", "2.1.245 (Claude Code)");
    expect(claudeReport).toStrictEqual({ raw: "2.1.245 (Claude Code)", semver: "2.1.245" });
  });

  it.each(["garbage", "2.1"])(
    "refuses %j fail-closed as driver.cli_version_unparseable (no coercion of partial versions)",
    (raw) => {
      let thrown: unknown;
      try {
        parseCliVersionReport("codex", raw);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DriverCliVersionUnparseableError);
      expect((thrown as DriverCliVersionUnparseableError).code).toBe(
        "driver.cli_version_unparseable",
      );
      expect((thrown as DriverCliVersionUnparseableError).fields.driverName).toBe("codex");
    },
  );
});

/** A controllable driver entry whose call history the assertions read. */
interface FakeDriverEntry {
  readonly entry: CapabilityRefreshDriverEntry;
  readonly refreshCalls: number[];
  readonly probeCalls: number[];
  setRefreshResult(result: DeclareDriverCapabilitiesResult | Error): void;
  setProbeResult(result: DriverAuthProbeResult | Error): void;
}

function buildFakeDriverEntry(driverName: FlooredDriverName): FakeDriverEntry {
  let refreshResult: DeclareDriverCapabilitiesResult | Error = {
    snapshotChange: "unchanged",
    cliVersionRefreshed: false,
  };
  let probeResult: DriverAuthProbeResult | Error = { status: "authenticated" };
  const refreshCalls: number[] = [];
  const probeCalls: number[] = [];
  return {
    entry: {
      driverName,
      refreshDeclaration: () => {
        refreshCalls.push(Date.now());
        return refreshResult instanceof Error
          ? Promise.reject(refreshResult)
          : Promise.resolve(refreshResult);
      },
      probeAuth: () => {
        probeCalls.push(Date.now());
        return probeResult instanceof Error
          ? Promise.reject(probeResult)
          : Promise.resolve(probeResult);
      },
    },
    refreshCalls,
    probeCalls,
    setRefreshResult(result) {
      refreshResult = result;
    },
    setProbeResult(result) {
      probeResult = result;
    },
  };
}

/** One scheduler plus the diagnostics it reported. */
function buildScheduler(): {
  readonly scheduler: CapabilityRefreshScheduler;
  readonly diagnostics: CapabilityRefreshDiagnostic[];
} {
  const diagnostics: CapabilityRefreshDiagnostic[] = [];
  const emitter = new DriverDiagnosticsEmitter({
    logSink: { record: () => undefined },
    counterSink: { increment: () => undefined },
  });
  const scheduler = new CapabilityRefreshScheduler({
    diagnostics: emitter,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { scheduler, diagnostics };
}

describe("CapabilityRefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the poll on the 15-minute cadence with the refresh PAIRED to the auth probe", async () => {
    const codex = buildFakeDriverEntry("codex");
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [codex.entry] });

    // One millisecond short of the cadence, nothing fires early.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS - 1);
    expect(codex.refreshCalls).toHaveLength(0);
    expect(codex.probeCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(codex.refreshCalls).toHaveLength(1);
    expect(codex.probeCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(2);
    expect(codex.probeCalls).toHaveLength(2);
    scheduler.shutdown();
  });

  it("surfaces a post-attach logout within one cadence period through the auth-state record", async () => {
    const claude = buildFakeDriverEntry("claude");
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [claude.entry] });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(scheduler.getAuthState("node-1", "claude")?.status).toBe("authenticated");
    expect(scheduler.getAuthState("node-1", "claude")?.observedAtMs).toBe(Date.now());

    claude.setProbeResult({ status: "unauthenticated", detail: "logged out" });
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    const record = scheduler.getAuthState("node-1", "claude");
    expect(record?.status).toBe("unauthenticated");
    expect(record?.detail).toBe("logged out");
    scheduler.shutdown();
  });

  it("records a THROWN probe as indeterminate (fail closed) and reports the failed leg", async () => {
    const codex = buildFakeDriverEntry("codex");
    const { scheduler, diagnostics } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [codex.entry] });

    codex.setProbeResult(new Error("probe transport died"));
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(scheduler.getAuthState("node-1", "codex")?.status).toBe("indeterminate");
    expect(diagnostics).toStrictEqual([
      {
        nodeId: "node-1",
        driverName: "codex",
        leg: "auth-probe",
        code: undefined,
        message: "probe transport died",
        // A leg that rejected settled; only a leg that never settled inside the backstop is a
        // timeout, and conflating the two would hide a hang.
        timedOut: false,
      },
    ]);
    scheduler.shutdown();
  });

  it("keeps polling past one driver's refresh refusal, and neither kills the sibling's poll", async () => {
    const codex = buildFakeDriverEntry("codex");
    const claude = buildFakeDriverEntry("claude");
    const { scheduler, diagnostics } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [codex.entry, claude.entry] });

    // A mid-lifetime downgrade below the floor: the refresh leg refuses, the diagnostic carries
    // the registered code, and the loop survives.
    codex.setRefreshResult(
      new DriverCliVersionBelowFloorError("codex", "0.140.0", DRIVER_CLI_VERSION_FLOORS.codex),
    );
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.leg).toBe("capability-refresh");
    expect(diagnostics[0]?.code).toBe("driver.cli_version_below_floor");
    // The sibling driver's pair still ran, and its auth record landed.
    expect(claude.refreshCalls).toHaveLength(1);
    expect(scheduler.getAuthState("node-1", "claude")?.status).toBe("authenticated");
    // The refusing driver's probe still ran: the pair settles independently.
    expect(scheduler.getAuthState("node-1", "codex")?.status).toBe("authenticated");

    // The next tick still fires, because a below-floor install is repairable.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(2);
    scheduler.shutdown();
  });

  it("clears the node's timer on detach and drops its auth records", async () => {
    const codex = buildFakeDriverEntry("codex");
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [codex.entry] });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(1);
    expect(scheduler.getAuthState("node-1", "codex")).toBeDefined();

    scheduler.stopForNode("node-1");
    expect(scheduler.getAuthState("node-1", "codex")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS * 3);
    expect(codex.refreshCalls).toHaveLength(1);
  });

  it("clears every node's timer at shutdown (no timer leaks)", async () => {
    const first = buildFakeDriverEntry("codex");
    const second = buildFakeDriverEntry("claude");
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [first.entry] });
    scheduler.startForNode({ nodeId: "node-2", drivers: [second.entry] });

    scheduler.shutdown();
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS * 3);
    expect(first.refreshCalls).toHaveLength(0);
    expect(second.refreshCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-attaching a node replaces its timer instead of stacking a second one", async () => {
    const codex = buildFakeDriverEntry("codex");
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [codex.entry] });
    scheduler.startForNode({ nodeId: "node-1", drivers: [codex.entry] });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    // One poll, not two: the re-attach replaced the first timer.
    expect(codex.refreshCalls).toHaveLength(1);
    scheduler.shutdown();
  });

  function buildHangingEntry(codex: FakeDriverEntry): {
    readonly entry: CapabilityRefreshDriverEntry;
    releaseHang: () => void;
  } {
    let resolveHang: ((result: DeclareDriverCapabilitiesResult) => void) | undefined;
    return {
      entry: {
        driverName: codex.entry.driverName,
        refreshDeclaration: () =>
          new Promise<DeclareDriverCapabilitiesResult>((resolve) => {
            resolveHang = resolve;
            codex.refreshCalls.push(Date.now());
          }),
        probeAuth: codex.entry.probeAuth,
      },
      releaseHang: () => resolveHang?.({ snapshotChange: "unchanged", cliVersionRefreshed: false }),
    };
  }

  function buildHangingProbeEntry(codex: FakeDriverEntry): {
    readonly entry: CapabilityRefreshDriverEntry;
    releaseProbe: (status: DriverAuthProbeResult["status"]) => void;
  } {
    let resolveProbe: ((result: DriverAuthProbeResult) => void) | undefined;
    return {
      entry: {
        driverName: codex.entry.driverName,
        refreshDeclaration: codex.entry.refreshDeclaration,
        probeAuth: () =>
          new Promise<DriverAuthProbeResult>((resolve) => {
            resolveProbe = resolve;
            codex.probeCalls.push(Date.now());
          }),
      },
      releaseProbe: (status) => resolveProbe?.({ status }),
    };
  }

  it("skips a tick while the previous poll of the same node is still INSIDE its deadline", async () => {
    const codex = buildFakeDriverEntry("codex");
    const hanging = buildHangingEntry(codex);
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [hanging.entry] });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(1);

    // One millisecond short of the leg deadline the poll is still legitimately in flight, so a
    // second poll of the same node coalesces. Driven through `refreshNow` because the cadence is
    // longer than the deadline and this test is about the in-flight guard, not the timer.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS - 1);
    await scheduler.refreshNow("node-1");
    expect(codex.refreshCalls).toHaveLength(1);

    hanging.releaseHang();
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(2);
    scheduler.shutdown();
  });

  it("abandons a leg that never settles, records it as timed out, and resumes the cadence", async () => {
    const codex = buildFakeDriverEntry("codex");
    const hanging = buildHangingEntry(codex);
    const { scheduler, diagnostics } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [hanging.entry] });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(1);
    expect(diagnostics).toHaveLength(0);

    // Past the deadline with the promise still unsettled. Without the backstop the in-flight
    // guard would hold this node's poll off forever.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.leg).toBe("capability-refresh");
    expect(diagnostics[0]?.timedOut).toBe(true);

    // The cadence resumed: the next tick polls rather than coalescing, and that poll is
    // abandoned identically, so the backstop is per poll and not a one-shot latch.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(2);
    expect(diagnostics).toHaveLength(2);

    // An abandoned promise settling late is inert: no third diagnostic and no unhandled
    // rejection, because both settlement handlers are attached before the race.
    hanging.releaseHang();
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnostics).toHaveLength(2);
    scheduler.shutdown();
  });

  it("keys an auth-state write to the node LIFETIME the poll started in", async () => {
    const codex = buildFakeDriverEntry("codex");
    // The probe is the hung leg deliberately: it is the only leg that writes an auth record, so
    // hanging another leg would pass on detach's record drop alone, testing nothing about the
    // guard.
    const hangingProbe = buildHangingProbeEntry(codex);
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [hangingProbe.entry] });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.probeCalls).toHaveLength(1);
    expect(scheduler.getAuthState("node-1", "codex")).toBeUndefined();

    // The node is detached and re-attached while its probe is in flight. That probe belongs to
    // the previous lifetime, and a monotonic generation tells the two apart where the identical
    // node id cannot.
    scheduler.stopForNode("node-1");
    scheduler.startForNode({ nodeId: "node-1", drivers: [hangingProbe.entry] });

    // A fulfilled `authenticated` reading released inside its deadline is the strongest case: it
    // is valid, just the wrong lifetime's, and the new lifetime is ready to receive it.
    hangingProbe.releaseProbe("authenticated");
    await vi.advanceTimersByTimeAsync(1);

    expect(scheduler.getAuthState("node-1", "codex")).toBeUndefined();
    scheduler.shutdown();
  });

  it("refreshNow runs an immediate poll outside the cadence (the provider-push lever)", async () => {
    const codex = buildFakeDriverEntry("codex");
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [codex.entry] });

    await scheduler.refreshNow("node-1");
    expect(codex.refreshCalls).toHaveLength(1);
    expect(codex.probeCalls).toHaveLength(1);
    expect(scheduler.getAuthState("node-1", "codex")?.status).toBe("authenticated");

    // The cadence is unaffected: the next timer tick still fires on schedule.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(2);
    scheduler.shutdown();
  });
});
