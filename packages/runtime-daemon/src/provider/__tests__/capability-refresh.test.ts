// T3.12 — CLI-version floor seam + CapabilityRefreshScheduler.
//
// Coverage targets (audit-derived):
//   * `Spec-005 §Required Behavior` (P0-2) — the per-driver minimum-version
//     floor is enforced mechanically; an unparseable version fails closed as
//     `driver.cli_version_unparseable` and a parseable below-floor version as
//     `driver.cli_version_below_floor`; a build AT or ABOVE the floor is
//     admitted, above the measured pin included.
//   * `Spec-005 §Resolved Questions and V1 Scope Decisions` (P2-9) — the
//     15-minute bounded cadence, per runtime node, with the capability refresh
//     PAIRED with the zero-turn auth probe; correctness never depends on push.
//   * CP-005-5 — change-detected emission is the WRITER's: a no-op poll and an
//     auth-only change append nothing to the timeline; the scheduler adds no
//     second change detection and no event sink of its own.
//   * The plan row's cadence test list: poll fires on schedule with the paired
//     probe; a changed snapshot emits `runtime_node.capability_updated`; a
//     no-op poll and an auth-only change emit nothing; the scheduler clears
//     its timer on shutdown/detach. Plus the fail-closed legs: a thrown probe
//     records `indeterminate`, and one driver's refresh refusal neither kills
//     the timer nor the sibling's poll.

import type { DriverAuthProbeResult } from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DriverDiagnosticsEmitter, type DriverDiagnosticRecord } from "../driver-diagnostics.js";
import type { DeclareDriverCapabilitiesResult } from "../driver-capabilities-writer.js";
import {
  CAPABILITY_REFRESH_INTERVAL_MS,
  CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS,
  CapabilityRefreshScheduler,
  DRIVER_CLI_VERSION_FLOORS,
  DriverCliVersionBelowFloorError,
  DriverCliVersionUnparseableError,
  assertCliVersionMeetsFloor,
  parseCliVersionReport,
  type CapabilityRefreshDiagnostic,
  type CapabilityRefreshDriverEntry,
  type FlooredDriverName,
} from "../capability-refresh.js";
import { CLI_VERSION_RAW_MAX_LEN } from "../provider-output-validation.js";

// --------------------------------------------------------------------------
// P0-2 — parse + floor seam
// --------------------------------------------------------------------------

describe("parseCliVersionReport", () => {
  it("derives the canonical semver from a prose-wrapped raw string, preserving raw verbatim", () => {
    const report = parseCliVersionReport("codex", "codex-cli 0.149.1 (build abc123)");
    expect(report).toStrictEqual({ raw: "codex-cli 0.149.1 (build abc123)", semver: "0.149.1" });

    const claudeReport = parseCliVersionReport("claude", "2.1.245 (Claude Code)");
    expect(claudeReport).toStrictEqual({ raw: "2.1.245 (Claude Code)", semver: "2.1.245" });
  });

  it("accepts a pre-release token", () => {
    const report = parseCliVersionReport("claude", "2.2.0-rc.1 (probe)");
    expect(report.semver).toBe("2.2.0-rc.1");
  });

  it.each(["garbage", "v2", "2.1", ""])(
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

  it("bounds the raw string carried on the error's fields to the persistence cap", () => {
    const oversized = "x".repeat(CLI_VERSION_RAW_MAX_LEN * 4);
    let thrown: unknown;
    try {
      parseCliVersionReport("claude", oversized);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as DriverCliVersionUnparseableError).fields.raw).toHaveLength(
      CLI_VERSION_RAW_MAX_LEN,
    );
  });
});

describe("assertCliVersionMeetsFloor", () => {
  it("admits a build exactly at the floor, and any build above it (above the pin included)", () => {
    expect(() =>
      assertCliVersionMeetsFloor("claude", { raw: "2.1.234", semver: "2.1.234" }),
    ).not.toThrow();
    expect(() =>
      assertCliVersionMeetsFloor("codex", { raw: "codex-cli 0.141.0", semver: "0.141.0" }),
    ).not.toThrow();
    // Newer-than-measured is the EXPECTED state, never a refusal condition.
    expect(() =>
      assertCliVersionMeetsFloor("claude", { raw: "9.0.0", semver: "9.0.0" }),
    ).not.toThrow();
    expect(() =>
      assertCliVersionMeetsFloor("codex", { raw: "codex-cli 0.150.1", semver: "0.150.1" }),
    ).not.toThrow();
  });

  it("refuses a below-floor build as driver.cli_version_below_floor with the floor named", () => {
    let thrown: unknown;
    try {
      assertCliVersionMeetsFloor("claude", { raw: "2.1.198 (Claude Code)", semver: "2.1.198" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DriverCliVersionBelowFloorError);
    const error = thrown as DriverCliVersionBelowFloorError;
    expect(error.code).toBe("driver.cli_version_below_floor");
    expect(error.fields).toStrictEqual({
      driverName: "claude",
      reportedSemver: "2.1.198",
      floor: DRIVER_CLI_VERSION_FLOORS.claude,
    });
  });

  it("refuses a non-canonical semver member fail-closed as unparseable rather than throwing raw", () => {
    // Reachable only via an untyped boundary — the gate still refuses typed.
    expect(() =>
      assertCliVersionMeetsFloor("codex", { raw: "codex-cli", semver: "not-a-version" }),
    ).toThrow(DriverCliVersionUnparseableError);
  });

  it("pins the ratified V1 floor values (Spec-005 §Required Behavior sets these)", () => {
    expect(DRIVER_CLI_VERSION_FLOORS).toStrictEqual({ claude: "2.1.234", codex: "0.141.0" });
  });
});

// --------------------------------------------------------------------------
// P2-9 — CapabilityRefreshScheduler
// --------------------------------------------------------------------------

/** A controllable driver entry whose call history the assertions read. */
interface FakeDriverEntry {
  readonly entry: CapabilityRefreshDriverEntry;
  readonly refreshCalls: number[];
  readonly probeCalls: number[];
  setRefreshResult(result: DeclareDriverCapabilitiesResult | Error): void;
  setProbeResult(result: DriverAuthProbeResult | Error): void;
}

// Simulates the T2.4 writer's emission decision so the "emits nothing" claims
// are asserted against an event list, not inferred: the fake appends to
// `emittedEvents` exactly when the writer would have emitted (declared /
// updated), and never on noop — which is the writer contract CP-005-5 pins.
function buildFakeDriverEntry(
  driverName: FlooredDriverName,
  emittedEvents: string[],
): FakeDriverEntry {
  let refreshResult: DeclareDriverCapabilitiesResult | Error = {
    emitted: "noop",
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
        if (refreshResult instanceof Error) {
          return Promise.reject(refreshResult);
        }
        if (refreshResult.emitted !== "noop") {
          emittedEvents.push(`${driverName}:runtime_node.capability_${refreshResult.emitted}`);
        }
        return Promise.resolve(refreshResult);
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

/**
 * One scheduler plus both of its diagnostic surfaces.
 *
 * The emitter is REQUIRED by the scheduler, so every construction site goes
 * through here: a test that reached for the bare constructor would be asserting
 * against a dependency shape the production code no longer accepts.
 */
function buildScheduler(): {
  readonly scheduler: CapabilityRefreshScheduler;
  readonly diagnostics: CapabilityRefreshDiagnostic[];
  readonly emittedDiagnosticRecords: DriverDiagnosticRecord[];
} {
  const diagnostics: CapabilityRefreshDiagnostic[] = [];
  const emittedDiagnosticRecords: DriverDiagnosticRecord[] = [];
  const emitter = new DriverDiagnosticsEmitter({
    logSink: { record: (record) => emittedDiagnosticRecords.push(record) },
    counterSink: { increment: () => undefined },
  });
  const scheduler = new CapabilityRefreshScheduler({
    diagnostics: emitter,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { scheduler, diagnostics, emittedDiagnosticRecords };
}

describe("CapabilityRefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the poll on the 15-minute cadence with the refresh PAIRED to the auth probe", async () => {
    const emittedEvents: string[] = [];
    const codex = buildFakeDriverEntry("codex", emittedEvents);
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [codex.entry] });

    // One millisecond short of the cadence: nothing fires early.
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

  it("surfaces a changed snapshot as capability_updated, while a no-op poll and an auth-only change emit nothing", async () => {
    const emittedEvents: string[] = [];
    const claude = buildFakeDriverEntry("claude", emittedEvents);
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [claude.entry] });

    // Tick 1: a genuinely changed snapshot — the writer emits.
    claude.setRefreshResult({ emitted: "updated", cliVersionRefreshed: true });
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(emittedEvents).toStrictEqual(["claude:runtime_node.capability_updated"]);

    // Tick 2: identical snapshot — a no-op poll appends nothing.
    claude.setRefreshResult({ emitted: "noop", cliVersionRefreshed: false });
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(emittedEvents).toHaveLength(1);

    // Tick 3: auth-only change (logout) — the record moves, the timeline does
    // not (the auth-state record updates out-of-band of the event surface).
    claude.setProbeResult({ status: "unauthenticated" });
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(emittedEvents).toHaveLength(1);
    expect(scheduler.getAuthState("node-1", "claude")?.status).toBe("unauthenticated");
    scheduler.shutdown();
  });

  it("surfaces a post-attach logout within one cadence period through the auth-state record", async () => {
    const emittedEvents: string[] = [];
    const claude = buildFakeDriverEntry("claude", emittedEvents);
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
    const emittedEvents: string[] = [];
    const codex = buildFakeDriverEntry("codex", emittedEvents);
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
        // A leg that REJECTED settled; only a leg that never settled inside the
        // backstop is a timeout, and conflating the two would hide a hang.
        timedOut: false,
      },
    ]);
    scheduler.shutdown();
  });

  it("keeps polling past one driver's refresh refusal, and neither kills the sibling's poll", async () => {
    const emittedEvents: string[] = [];
    const codex = buildFakeDriverEntry("codex", emittedEvents);
    const claude = buildFakeDriverEntry("claude", emittedEvents);
    const { scheduler, diagnostics } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [codex.entry, claude.entry] });

    // A mid-lifetime downgrade below the floor: the refresh leg refuses, the
    // diagnostic carries the registered code, and the loop survives.
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
    // The refusing driver's PROBE still ran too — the pair settles independently.
    expect(scheduler.getAuthState("node-1", "codex")?.status).toBe("authenticated");

    // Next tick still fires — a below-floor install is repairable.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(2);
    scheduler.shutdown();
  });

  it("clears the node's timer on detach and drops its auth records", async () => {
    const emittedEvents: string[] = [];
    const codex = buildFakeDriverEntry("codex", emittedEvents);
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
    const emittedEvents: string[] = [];
    const first = buildFakeDriverEntry("codex", emittedEvents);
    const second = buildFakeDriverEntry("claude", emittedEvents);
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
    const emittedEvents: string[] = [];
    const codex = buildFakeDriverEntry("codex", emittedEvents);
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
      releaseHang: () => resolveHang?.({ emitted: "noop", cliVersionRefreshed: false }),
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
    const emittedEvents: string[] = [];
    const codex = buildFakeDriverEntry("codex", emittedEvents);
    const hanging = buildHangingEntry(codex);
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [hanging.entry] });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(1);

    // One millisecond short of the leg deadline: the poll is still legitimately
    // in flight, so a second poll of the SAME node coalesces rather than
    // stacking. Driven through `refreshNow` because the cadence itself is
    // longer than the deadline, and this assertion is about the in-flight
    // guard rather than about the timer.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS - 1);
    await scheduler.refreshNow("node-1");
    expect(codex.refreshCalls).toHaveLength(1);

    hanging.releaseHang();
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(2);
    scheduler.shutdown();
  });

  it("abandons a leg that never settles, records it as timed out, and resumes the cadence", async () => {
    const emittedEvents: string[] = [];
    const codex = buildFakeDriverEntry("codex", emittedEvents);
    const hanging = buildHangingEntry(codex);
    const { scheduler, diagnostics } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [hanging.entry] });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(1);
    expect(diagnostics).toHaveLength(0);

    // Past the deadline with the promise STILL unsettled. Without the backstop
    // the in-flight guard would hold this node's poll off forever, and the
    // bounded-cadence guarantee would quietly become "until a leg hangs".
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.leg).toBe("capability-refresh");
    expect(diagnostics[0]?.timedOut).toBe(true);

    // The cadence resumed: the next tick polls rather than coalescing. That
    // poll hangs identically and is abandoned identically — the backstop is
    // per-poll, not a one-shot latch.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.refreshCalls).toHaveLength(2);
    expect(diagnostics).toHaveLength(2);

    // And an abandoned promise settling LATE is inert — no third diagnostic,
    // and no unhandled rejection, because both settlement handlers are attached
    // before the race rather than only the winning one.
    hanging.releaseHang();
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnostics).toHaveLength(2);
    scheduler.shutdown();
  });

  it("keys an auth-state write to the node LIFETIME the poll started in", async () => {
    const emittedEvents: string[] = [];
    const codex = buildFakeDriverEntry("codex", emittedEvents);
    // The PROBE is the hung leg deliberately: it is the only leg that writes an
    // auth record, so hanging any other leg would leave this test passing on
    // detach's record drop alone and asserting nothing about the guard.
    const hangingProbe = buildHangingProbeEntry(codex);
    const { scheduler } = buildScheduler();
    scheduler.startForNode({ nodeId: "node-1", drivers: [hangingProbe.entry] });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS);
    expect(codex.probeCalls).toHaveLength(1);
    expect(scheduler.getAuthState("node-1", "codex")).toBeUndefined();

    // The node is detached and re-attached WHILE its probe is in flight. That
    // probe belongs to the previous lifetime: writing its reading into the new
    // one would report an auth state observed against a node registration that
    // no longer exists, and a monotonic generation is what tells them apart —
    // a bare node-id key cannot, because the id is identical across the two.
    scheduler.stopForNode("node-1");
    scheduler.startForNode({ nodeId: "node-1", drivers: [hangingProbe.entry] });

    // A FULFILLED `authenticated` reading, released inside its deadline, is the
    // strongest case: the reading is valid, it is simply the wrong lifetime's,
    // and the re-attached lifetime has an auth-state map ready to receive it.
    hangingProbe.releaseProbe("authenticated");
    await vi.advanceTimersByTimeAsync(1);

    expect(scheduler.getAuthState("node-1", "codex")).toBeUndefined();
    scheduler.shutdown();
  });

  it("refreshNow runs an immediate poll outside the cadence (the provider-push lever)", async () => {
    const emittedEvents: string[] = [];
    const codex = buildFakeDriverEntry("codex", emittedEvents);
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

  it("refreshNow against an unregistered node is a no-op, never a throw", async () => {
    const { scheduler } = buildScheduler();
    await expect(scheduler.refreshNow("node-unknown")).resolves.toBeUndefined();
  });
});
