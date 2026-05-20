// NodePtyHost shutdown drain tests — Plan-001 §CP-001-1 polymorphic axis.
//
// What this asserts:
//
//   * Contract surface (`PtyHost.shutdown` per
//     `packages/contracts/src/pty-host.ts`): `shutdown()` returns a
//     `DrainResult` with the four-value summary (drained / forced /
//     sidecar-clean / taskkill-escalated). In-process backend
//     vacuously reports `sidecarExitedCleanly: true` +
//     `taskkillEscalated: false`.
//   * Per-session graceful drain: a session that exits within
//     `perSessionTimeoutMs` after SIGTERM counts under
//     `sessionsDrained`.
//   * Per-session forced kill: a session that does NOT exit before
//     the timeout fires escalates to SIGKILL and counts under
//     `sessionsForcedKilled`.
//   * Idempotent re-entrancy: a second `shutdown()` call returns the
//     same Promise as the in-flight first call (Promise-memoization).
//   * Already-exited sessions: a session whose `child.onExit` fired
//     before `shutdown()` was called does NOT contribute to either
//     counter (the filter at shutdown entry excludes sessions with
//     `exitCode !== null`).
//
// Why we mock `NodePtyChild`:
//   The production path consumes `node-pty` via the injectable
//   `NodePtyHostDeps.ptySpawn` seam. Tests inject a recording fake
//   whose `onExit` listener captures the closure passed by
//   `NodePtyHost.spawn()` — `triggerExit()` then drives a synthetic
//   exit at the moment the test scenario demands (graceful vs.
//   timeout vs. pre-shutdown).
//
// Refs:
//   • Plan-001 §Cross-Plan Obligations CP-001-1 — drain orchestration
//     contract.
//   • `packages/contracts/src/pty-host.ts` — `PtyHost.shutdown` +
//     `DrainResult` interface declarations.
//   • ADR-019 §Decision item 8 — backend polymorphism (in-process
//     backend has no sidecar process to drain, hence vacuous host
//     fields).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { NodePtyHost } from "../node-pty-host.js";
import type {
  ConsoleCtrlEvent,
  NodePtyChild,
  NodePtySpawnFn,
  TaskkillResult,
} from "../node-pty-host.js";
import { makeFakeChild } from "./_fakes.js";

import type { DrainResult, SpawnRequest } from "@ai-sidekicks/contracts";

const SAMPLE_SPAWN: SpawnRequest = {
  kind: "spawn_request",
  command: "/bin/sh",
  args: ["-c", "sleep 10"],
  env: [],
  cwd: "/tmp",
  rows: 24,
  cols: 80,
};

interface ShutdownCtx {
  host: NodePtyHost;
  spawnedChildren: Array<{
    child: NodePtyChild;
    triggerExit: (exitCode: number, signal?: number) => void;
  }>;
  ptySpawnStub: Mock<NodePtySpawnFn>;
  exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void>;
  mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void>;
  mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>>;
}

let ctx: ShutdownCtx;

beforeEach(() => {
  // Fake timers — `shutdown()` races `drainWaiter` against a
  // `deps.setTimer` timeout; `vi.useFakeTimers()` lets us advance
  // simulated time deterministically without wall-clock waits.
  vi.useFakeTimers();

  const spawnedChildren: ShutdownCtx["spawnedChildren"] = [];
  const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockImplementation(() => {
    // Mint a fresh fake per spawn — each session has its own onExit
    // closure that `triggerExit` drives.
    const entry = makeFakeChild(10000 + spawnedChildren.length);
    spawnedChildren.push(entry);
    return entry.child;
  });
  const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
    vi.fn();
  const mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void> = vi.fn();
  const mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
    .fn<(pid: number) => Promise<TaskkillResult>>()
    .mockResolvedValue({ exitCode: 0 });

  const host = new NodePtyHost({
    // Default to POSIX so the kill path takes the simple
    // `record.child.kill(signal)` branch — the Windows escalation
    // path is owned by separate K1/K3 tests.
    platform: "linux",
    ptySpawn: ptySpawnStub,
    generateConsoleCtrlEvent: mockGCCE,
    spawnTaskkill: mockTaskkill,
  });
  host.setOnExit(exitRecorder);

  ctx = {
    host,
    spawnedChildren,
    ptySpawnStub,
    exitRecorder,
    mockGCCE,
    mockTaskkill,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NodePtyHost.shutdown — Plan-001 CP-001-1 polymorphic drain", () => {
  it("with no active sessions returns a vacuous DrainResult (0/0, host clean)", async () => {
    const result: DrainResult = await ctx.host.shutdown({
      perSessionTimeoutMs: 100,
      hostTimeoutMs: 100,
    });

    expect(result).toEqual({
      sessionsDrained: 0,
      sessionsForcedKilled: 0,
      // In-process backend: no sidecar to wind down.
      sidecarExitedCleanly: true,
      taskkillEscalated: false,
    });
  });

  it("counts a session that exits gracefully under sessionsDrained", async () => {
    const spawnResp = await ctx.host.spawn(SAMPLE_SPAWN);
    expect(ctx.spawnedChildren).toHaveLength(1);

    // Start the drain — it issues SIGTERM internally; we then
    // synchronously trigger the child's exit so the drain waiter
    // resolves before the timeout fires.
    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    // Yield so `kill()` (an `await` inside `drainSingleSession`)
    // returns and the timer arms; then trigger exit. The session
    // record's `child.onExit` subscription resolves the drain waiter
    // via `notifyShutdownWaiter`.
    await Promise.resolve();
    await Promise.resolve();
    ctx.spawnedChildren[0]!.triggerExit(0);

    const result: DrainResult = await drainPromise;

    expect(result.sessionsDrained).toBe(1);
    expect(result.sessionsForcedKilled).toBe(0);
    expect(result.sidecarExitedCleanly).toBe(true);
    expect(result.taskkillEscalated).toBe(false);

    // The session's exit listener fired with the real (0) exit code,
    // not the synthetic crash sentinel.
    expect(ctx.exitRecorder).toHaveBeenCalledWith(spawnResp.session_id, 0);
  });

  it("counts a session that exceeds the per-session timeout under sessionsForcedKilled", async () => {
    await ctx.host.spawn(SAMPLE_SPAWN);

    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    // Do NOT trigger exit — let the timer fire so the drain escalates
    // to SIGKILL. Advance both the per-session timer AND the host
    // timer so the final drain resolves end-to-end.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_001);
    // Yield so the SIGKILL escalation completes (it issues another
    // `await this.kill(...)` internally).
    await Promise.resolve();
    await Promise.resolve();

    const result: DrainResult = await drainPromise;

    expect(result.sessionsDrained).toBe(0);
    expect(result.sessionsForcedKilled).toBe(1);
    // In-process backend: host fields vacuous regardless of session
    // escalation outcome.
    expect(result.sidecarExitedCleanly).toBe(true);
    expect(result.taskkillEscalated).toBe(false);
  });

  it("is idempotent and re-entrant — a second shutdown() call returns the same in-flight Promise", async () => {
    await ctx.host.spawn(SAMPLE_SPAWN);

    const firstPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });
    const secondPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    // Promise-memoization: the second call returns the same Promise
    // identity as the first (mirrors `inflightSpawn` per
    // `RustSidecarPtyHost`).
    expect(secondPromise).toBe(firstPromise);

    await Promise.resolve();
    await Promise.resolve();
    ctx.spawnedChildren[0]!.triggerExit(0);

    const firstResult = await firstPromise;
    const secondResult = await secondPromise;
    // Same Promise identity → same resolved value.
    expect(secondResult).toBe(firstResult);
  });

  it("excludes already-exited sessions from both counters at shutdown entry", async () => {
    const spawnResp = await ctx.host.spawn(SAMPLE_SPAWN);

    // Pre-emptive exit BEFORE shutdown — the session's record.exitCode
    // is populated by `child.onExit`. `shutdown()`'s entry filter
    // skips sessions with `exitCode !== null` so neither counter
    // increments.
    ctx.spawnedChildren[0]!.triggerExit(0);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(spawnResp.session_id, 0);

    const result = await ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    expect(result.sessionsDrained).toBe(0);
    expect(result.sessionsForcedKilled).toBe(0);
  });

  it("drains multiple sessions concurrently and reports the aggregate counts", async () => {
    // Spawn three sessions; trigger graceful exit for two and let the
    // third time out.
    await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.spawn(SAMPLE_SPAWN);
    expect(ctx.spawnedChildren).toHaveLength(3);

    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    // Trigger graceful exits for sessions 0 + 1; leave session 2 to
    // time out.
    await Promise.resolve();
    await Promise.resolve();
    ctx.spawnedChildren[0]!.triggerExit(0);
    ctx.spawnedChildren[1]!.triggerExit(0);
    await vi.advanceTimersByTimeAsync(2_001);
    await Promise.resolve();
    await Promise.resolve();

    const result = await drainPromise;
    expect(result.sessionsDrained).toBe(2);
    expect(result.sessionsForcedKilled).toBe(1);
  });
});
