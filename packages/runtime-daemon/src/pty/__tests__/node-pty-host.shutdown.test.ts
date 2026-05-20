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
import { PtyBackendUnavailableError } from "../rust-sidecar-pty-host.js";
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

  it("refuses spawn() once shutdown has started (terminal-host contract per PtyHost.shutdown JSDoc)", async () => {
    // Race shape this exercises:
    //
    //   (1) Consumer spawns a session pre-shutdown — it lands in
    //       `this.sessions` and contributes to the `activeSessionIds`
    //       snapshot inside `runShutdown`.
    //   (2) `shutdown()` flips `shuttingDown = true` synchronously at
    //       the top of `runShutdown`, BEFORE the snapshot, so a
    //       concurrent `spawn()` racing the start of the drain
    //       observes the flag at the top-of-method gate.
    //   (3) That concurrent `spawn()` rejects with
    //       `PtyBackendUnavailableError` carrying
    //       `attemptedBackend: "node-pty"` — without this gate the
    //       new session would be accepted but excluded from the
    //       drain snapshot, so `shutdown()` could resolve while the
    //       new PTY child is still running (the orphan condition
    //       the `PtyHost.shutdown` JSDoc forbids).
    //
    // Refs:
    //   • `packages/contracts/src/pty-host.ts` `PtyHost.shutdown` —
    //     "Shutdown is TERMINAL for the host instance: after
    //     `shutdown()` resolves, the host MUST refuse new `spawn()`
    //     calls."
    //   • `RustSidecarPtyHost` `ensureChild()` — the analogous gate
    //     on the out-of-process backend.

    await ctx.host.spawn(SAMPLE_SPAWN);
    expect(ctx.spawnedChildren).toHaveLength(1);

    // Kick off the drain — `runShutdown` flips `shuttingDown = true`
    // synchronously before yielding. We do NOT await the drainPromise
    // yet: the gate must reject mid-drain, not only post-resolution.
    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    // Yield once so the synchronous `shuttingDown = true` + snapshot
    // prefix of `runShutdown` has executed before the second
    // `spawn()` enters its gate. (Belt-and-braces — the flag flips
    // before the first `await` so even without this yield the gate
    // would observe `true`; the yield matches the rust-sidecar
    // analog test's flushMicrotasks pattern.)
    await Promise.resolve();

    // Assertion 1 + 2 + 3: rejects with `PtyBackendUnavailableError`,
    // `attemptedBackend === "node-pty"`, and a debuggable message
    // that names the terminal-host condition.
    const secondSpawnPromise = ctx.host.spawn(SAMPLE_SPAWN);
    await expect(secondSpawnPromise).rejects.toBeInstanceOf(PtyBackendUnavailableError);
    await expect(secondSpawnPromise).rejects.toMatchObject({
      details: { attemptedBackend: "node-pty" },
    });
    await expect(secondSpawnPromise).rejects.toThrow(/shutdown\(\)|terminal/);

    // The rejected `spawn()` must NOT have called through to the
    // injected `ptySpawn` stub — the gate intercepts before any
    // node-pty primitive runs. (The first session, spawned
    // pre-shutdown, is the only legitimate call.)
    expect(ctx.ptySpawnStub).toHaveBeenCalledTimes(1);

    // Clean up: let the first session exit so the drain resolves.
    await Promise.resolve();
    ctx.spawnedChildren[0]!.triggerExit(0);
    await drainPromise;
  });

  it("refuses spawn() if shutdown() starts mid-resolvePtySpawn (post-await re-check)", async () => {
    // Race shape this exercises — distinct from the entry-guard test
    // above:
    //
    //   (1) Consumer calls `spawn(request)` BEFORE shutdown has been
    //       invoked. The top-of-method `if (this.shuttingDown)` gate
    //       observes `false` and the method proceeds to
    //       `await this.resolvePtySpawn()`. Because `resolvePtySpawn`
    //       is an `async` method, the `await` introduces a microtask
    //       yield even when the body resolves synchronously (the
    //       `deps.ptySpawn !== null` branch caches + returns without
    //       awaiting anything itself).
    //   (2) DURING that microtask yield, `shutdown()` is invoked.
    //       `runShutdown`'s synchronous prefix flips
    //       `this.shuttingDown = true` BEFORE the first `await` (the
    //       same property the entry-guard test relies on, just
    //       observed from the opposite race direction).
    //   (3) When the microtask queue drains, `spawn()` resumes past
    //       the `await this.resolvePtySpawn()` line. The post-await
    //       re-check observes `shuttingDown === true` and rejects
    //       with `PtyBackendUnavailableError` BEFORE invoking
    //       `ptySpawn(...)` — the entire point being that no orphan
    //       PTY child escapes the drain snapshot taken inside
    //       `runShutdown`.
    //
    // Discriminating assertion: `ptySpawnStub` was NEVER invoked. The
    // entry-guard test asserts ptySpawn ran exactly once (for the
    // pre-shutdown session), here it must be zero — proving the
    // rejection landed strictly between the entry guard and the
    // `ptySpawn(spec.command, ...)` invocation, i.e., on the
    // post-await branch.
    //
    // Refs:
    //   • `RustSidecarPtyHost` `resolveOutstanding` spawn_response
    //     re-check (rust-sidecar-pty-host.ts, around line 2508) —
    //     the sister-backend precedent that closes the equivalent
    //     in-flight race on the out-of-process backend.
    //   • `packages/contracts/src/pty-host.ts` `PtyHost.shutdown` —
    //     terminal-host contract surface: a session that escapes the
    //     drain snapshot violates the "no orphan child past
    //     shutdown() resolution" obligation.

    // No pre-shutdown spawn — we want `ptySpawnStub` to remain
    // call-count = 0 so the assertion below is unambiguous.

    // Kick off `spawn()` synchronously. It runs through the entry
    // guard (false here) and suspends on `await this.resolvePtySpawn()`.
    // We capture the returned Promise; we do NOT await yet.
    const racingSpawnPromise = ctx.host.spawn(SAMPLE_SPAWN);

    // Immediately invoke `shutdown()` BEFORE yielding any
    // microtasks. `runShutdown`'s synchronous prefix flips
    // `this.shuttingDown = true` before its first `await` — same
    // property the entry-guard test relies on. The flag flip is
    // observed by the post-await re-check inside the racing
    // `spawn()` when it resumes.
    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 100,
      hostTimeoutMs: 100,
    });

    // Microtask queue drains here: `spawn()` resumes past
    // `await this.resolvePtySpawn()`, observes the flipped flag, and
    // throws. The post-await re-check is the only guard that can
    // catch this race; the entry guard already passed.
    await expect(racingSpawnPromise).rejects.toBeInstanceOf(PtyBackendUnavailableError);
    await expect(racingSpawnPromise).rejects.toMatchObject({
      details: { attemptedBackend: "node-pty" },
    });
    // Match the uniform error-message regex used by the entry-guard
    // test so the contract stays uniform across both rejection
    // paths.
    await expect(racingSpawnPromise).rejects.toThrow(/shutdown\(\)|terminal/);

    // The load-bearing assertion: `ptySpawn` was NEVER invoked. This
    // proves the rejection landed BEFORE `ptySpawn(spec.command,
    // ...)` ran — i.e., no orphan PTY child was created. The
    // entry-guard test asserts `toHaveBeenCalledTimes(1)` (the
    // pre-shutdown session); here we assert zero because there is
    // no pre-shutdown session.
    expect(ctx.ptySpawnStub).not.toHaveBeenCalled();

    // Drain Promise resolves vacuously (no active sessions to
    // drain — the racing spawn was rejected before
    // `this.sessions.set(...)`).
    const result: DrainResult = await drainPromise;
    expect(result.sessionsDrained).toBe(0);
    expect(result.sessionsForcedKilled).toBe(0);
  });

  it("refuses spawn() after shutdown() has resolved (terminal-host contract holds post-drain)", async () => {
    // Pins the post-resolution case: once `shutdown()` resolves the
    // host instance MUST stay terminal. The same `shuttingDown` flag
    // enforces this — it never flips back to `false`, so a `spawn()`
    // attempted AFTER the per-session drain completes is rejected
    // with the identical `PtyBackendUnavailableError` shape as the
    // in-flight case above.

    // Spawn a session pre-shutdown so the drain has real work to do —
    // this exercises the post-per-session-drain state (drain ran,
    // resolved, flag is still `true`), not just the no-session
    // vacuous-resolve case.
    await ctx.host.spawn(SAMPLE_SPAWN);
    expect(ctx.spawnedChildren).toHaveLength(1);

    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    // Yield + trigger graceful exit so the drain resolves cleanly
    // (mirrors the "graceful drain" test above).
    await Promise.resolve();
    await Promise.resolve();
    ctx.spawnedChildren[0]!.triggerExit(0);

    const result = await drainPromise;
    expect(result.sessionsDrained).toBe(1);
    expect(result.sessionsForcedKilled).toBe(0);

    // Post-resolution `spawn()` rejects with the same shape — the
    // gate observes `shuttingDown === true` and refuses before
    // `ptySpawn` can run.
    const postShutdownSpawn = ctx.host.spawn(SAMPLE_SPAWN);
    await expect(postShutdownSpawn).rejects.toBeInstanceOf(PtyBackendUnavailableError);
    await expect(postShutdownSpawn).rejects.toMatchObject({
      details: { attemptedBackend: "node-pty" },
    });

    // `ptySpawn` was called exactly once — for the pre-shutdown
    // session, not for the rejected post-shutdown attempt.
    expect(ctx.ptySpawnStub).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// Codex P2 (PR #83 thread `PRRT_kwDOSCycWc6DZEKP`):
//   `NodePtyHost.drainSingleSession` Windows-only race where a
//   `taskkill`-killed session was miscounted as `sessionsDrained`
//   instead of `sessionsForcedKilled`.
//
// Trace (pre-fix):
//   1. `drainSingleSession` sets `perSessionTimeoutMs = 5000`, installs
//      the shutdownWaiter, calls `kill(s-0, "SIGTERM")`.
//   2. On Windows, `killOnWindows` fires `CTRL_BREAK_EVENT` and arms a
//      2 s internal escalation timer.
//   3. The child IGNORES `CTRL_BREAK_EVENT` (stuck process or no
//      console-control handler installed).
//   4. At T+2s, the 2 s timer fires → `invokeTaskkill` runs →
//      `spawnTaskkill(pid)` resolves → synthetic `fireExit(s-0, 1,
//      undefined)` + `notifyShutdownWaiter("forced")`.
//   5. Pre-fix: the drainWaiter resolved with UNCONDITIONAL `"drained"`
//      → `Promise.race` won at "drained" → session counted under
//      `sessionsDrained`, miscounting a force-killed session as a
//      gracefully drained one.
//   6. Post-fix: the drainWaiter carries the resolver's truth —
//      `record.escalated ? "forced" : "drained"` — so the race observes
//      `"forced"`, and `drainSingleSession` returns `"forced"` →
//      session counted under `sessionsForcedKilled`.
//
// These tests use `platform: "win32"` and inject inline mocks (GCCE +
// spawnTaskkill) instead of leaning on the shared `ctx` beforeEach
// (which uses `platform: "linux"`). The discriminator across all three
// tests is the cross-product of `mockTaskkill` invocation + drained vs
// forced counter, NOT the `onExit` payload (which the existing
// tree-kill tests pin).
// ----------------------------------------------------------------------------

describe("NodePtyHost.shutdown — Windows taskkill-escalation race (Codex P2 PRRT_kwDOSCycWc6DZEKP)", () => {
  it("counts a session under sessionsForcedKilled when the 2 s SIGTERM-escalation timer fires before perSessionTimeoutMs", async () => {
    // Headline regression: pre-fix this would assert
    // `sessionsDrained === 1`, miscounting the taskkill-killed session.
    // Post-fix the drainWaiter carries `"forced"` from the
    // synthetic-exit path inside `invokeTaskkill`.
    const winSpawn = makeFakeChild(70000);
    const winPtySpawn: Mock<NodePtySpawnFn> = vi
      .fn<NodePtySpawnFn>()
      .mockReturnValue(winSpawn.child);
    // GCCE that does NOTHING — the child ignores `CTRL_BREAK_EVENT`,
    // so the only path that resolves the drainWaiter is the 2 s
    // escalation timer firing taskkill.
    const winGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void> = vi.fn();
    const winTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
      .fn<(pid: number) => Promise<TaskkillResult>>()
      .mockResolvedValue({ exitCode: 0 });
    const winExitRecorder: Mock<
      (sessionId: string, exitCode: number, signalCode?: number) => void
    > = vi.fn();

    const winHost = new NodePtyHost({
      platform: "win32",
      ptySpawn: winPtySpawn,
      generateConsoleCtrlEvent: winGCCE,
      spawnTaskkill: winTaskkill,
    });
    winHost.setOnExit(winExitRecorder);

    await winHost.spawn(SAMPLE_SPAWN);

    // `perSessionTimeoutMs = 5000` is the load-bearing parameter:
    // strictly greater than the 2 s internal escalation timer in
    // `killOnWindows`, so the escalation MUST fire BEFORE the
    // per-session timeout. Pre-fix this was the exact condition the
    // race demanded to surface — `perSessionTimeoutMs < 2000` would
    // route through the per-session timeout SIGKILL escalation path
    // (a different code path, also fixed but covered separately by
    // the existing "exceeds per-session timeout" test above).
    const drainPromise = winHost.shutdown({
      perSessionTimeoutMs: 5_000,
      hostTimeoutMs: 10_000,
    });

    // Yield so `drainSingleSession`'s `kill()` await completes and
    // `killOnWindows` arms the 2 s timer.
    await Promise.resolve();
    await Promise.resolve();

    // Pre-budget: CTRL_BREAK_EVENT fired, taskkill has NOT yet been
    // invoked.
    expect(winGCCE).toHaveBeenCalledTimes(1);
    expect(winGCCE).toHaveBeenCalledWith(1, 70000);
    expect(winTaskkill).not.toHaveBeenCalled();

    // Cross the 2 s budget. The escalation timer fires → invokeTaskkill
    // → spawnTaskkill resolves → synthetic exit + notifyShutdownWaiter
    // → drainWaiter resolves with "forced" → Promise.race observes
    // "forced" → drainSingleSession returns "forced".
    await vi.advanceTimersByTimeAsync(2_001);
    await Promise.resolve();
    await Promise.resolve();

    const result = await drainPromise;

    // Discriminator: the session counts under `sessionsForcedKilled`,
    // NOT `sessionsDrained`. Pre-fix the assertion below would be
    // `sessionsDrained === 1` and `sessionsForcedKilled === 0` —
    // miscounting the taskkill-killed child as a graceful drain.
    expect(result.sessionsDrained).toBe(0);
    expect(result.sessionsForcedKilled).toBe(1);

    // Load-bearing complementary assertion: `taskkill` DID fire (the
    // session was force-killed, not gracefully drained). Without
    // this assertion, a future bug that flips the counters without
    // actually invoking taskkill would pass the test above
    // vacuously.
    expect(winTaskkill).toHaveBeenCalledTimes(1);
    expect(winTaskkill).toHaveBeenCalledWith(70000);

    // The synthetic `onExit(s-0, 1, undefined)` fired exactly once —
    // emitted by `invokeTaskkill` per I-024-2 even when the OS-level
    // reap is opaque.
    expect(winExitRecorder).toHaveBeenCalledTimes(1);
    expect(winExitRecorder).toHaveBeenCalledWith(expect.any(String), 1);

    // In-process backend: host fields vacuous regardless of session
    // escalation outcome.
    expect(result.sidecarExitedCleanly).toBe(true);
    expect(result.taskkillEscalated).toBe(false);
  });

  it("does NOT double-count when child.onExit fires after the taskkill synthetic exit", async () => {
    // Dedupe-path race regression: when the taskkill-reaped child's
    // real `onExit` event reaches the spawn-time subscription AFTER
    // the synthetic `fireExit(1, undefined)` already populated
    // `record.exitCode`, the de-dupe branch at L593-605 of
    // `node-pty-host.ts` runs. Pre-fix that branch did NOT call
    // `notifyShutdownWaiter` at all (the waiter had already been
    // resolved by the synthetic-exit path and deleted), but its
    // outcome was "drained" — so post-fix the de-dupe path
    // unconditionally passes `"forced"` per the call-site discipline
    // rustdoc at L979-983. This test pins both halves: the synthetic
    // exit fires, the natural exit then fires, and the session still
    // counts under `sessionsForcedKilled` (NOT double-counted, NOT
    // miscounted).
    const winSpawn = makeFakeChild(70001);
    const winPtySpawn: Mock<NodePtySpawnFn> = vi
      .fn<NodePtySpawnFn>()
      .mockReturnValue(winSpawn.child);
    const winGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void> = vi.fn();
    const winTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
      .fn<(pid: number) => Promise<TaskkillResult>>()
      .mockResolvedValue({ exitCode: 0 });
    const winExitRecorder: Mock<
      (sessionId: string, exitCode: number, signalCode?: number) => void
    > = vi.fn();

    const winHost = new NodePtyHost({
      platform: "win32",
      ptySpawn: winPtySpawn,
      generateConsoleCtrlEvent: winGCCE,
      spawnTaskkill: winTaskkill,
    });
    winHost.setOnExit(winExitRecorder);

    await winHost.spawn(SAMPLE_SPAWN);

    const drainPromise = winHost.shutdown({
      perSessionTimeoutMs: 5_000,
      hostTimeoutMs: 10_000,
    });

    await Promise.resolve();
    await Promise.resolve();

    // Fire the 2 s escalation timer → invokeTaskkill → synthetic exit
    // + notifyShutdownWaiter.
    await vi.advanceTimersByTimeAsync(2_001);
    await Promise.resolve();
    await Promise.resolve();

    // Pre-condition: the synthetic exit already fired exactly once.
    expect(winExitRecorder).toHaveBeenCalledTimes(1);
    expect(winExitRecorder).toHaveBeenCalledWith(expect.any(String), 1);

    // NOW drive the underlying child's natural `onExit` event (the OS
    // eventually reaped the child via taskkill; node-pty's
    // subscription fires the listener). The de-dupe branch must NOT
    // re-fire onExit (idempotency contract) — `record.exitCode !==
    // null` short-circuits the fireExit path.
    winSpawn.triggerExit(1, undefined);
    await Promise.resolve();
    await Promise.resolve();

    const result = await drainPromise;

    // Discriminator: still exactly ONE `onExit` emission (the
    // synthetic). The de-dupe path did not double-fire.
    expect(winExitRecorder).toHaveBeenCalledTimes(1);

    // Discriminator: the session counts under `sessionsForcedKilled`,
    // not double-counted (would imply `1 + 1 = 2` if the de-dupe
    // path mis-routed) and not miscounted as "drained" (the original
    // P2 #1 bug).
    expect(result.sessionsDrained).toBe(0);
    expect(result.sessionsForcedKilled).toBe(1);
  });

  it("counts a session under sessionsDrained when the child exits naturally on CTRL_BREAK_EVENT before the 2 s escalation timer fires", async () => {
    // Sanity counterpart: the post-fix branch `record.escalated ?
    // "forced" : "drained"` MUST NOT over-classify a genuine graceful
    // drain as forced. Discriminator: `mockTaskkill` is NEVER called
    // — the child exits in response to CTRL_BREAK_EVENT well within
    // the 2 s budget, the escalation timer is cancelled by
    // `clearPendingEscalation` in the spawn-time `child.onExit`
    // closure, and the drainWaiter resolves with "drained" via the
    // L631 call site.
    const winSpawn = makeFakeChild(70002);
    const winPtySpawn: Mock<NodePtySpawnFn> = vi
      .fn<NodePtySpawnFn>()
      .mockReturnValue(winSpawn.child);
    // GCCE that synchronously fires the child's exit listener —
    // simulating a child that responds to CTRL_BREAK_EVENT by exiting
    // immediately (a well-behaved Win32 console process).
    const winGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void> = vi
      .fn<(event: ConsoleCtrlEvent, pid: number) => void>()
      .mockImplementation(() => {
        winSpawn.triggerExit(0, undefined);
      });
    const winTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
      .fn<(pid: number) => Promise<TaskkillResult>>()
      .mockResolvedValue({ exitCode: 0 });
    const winExitRecorder: Mock<
      (sessionId: string, exitCode: number, signalCode?: number) => void
    > = vi.fn();

    const winHost = new NodePtyHost({
      platform: "win32",
      ptySpawn: winPtySpawn,
      generateConsoleCtrlEvent: winGCCE,
      spawnTaskkill: winTaskkill,
    });
    winHost.setOnExit(winExitRecorder);

    await winHost.spawn(SAMPLE_SPAWN);

    const drainPromise = winHost.shutdown({
      perSessionTimeoutMs: 5_000,
      hostTimeoutMs: 10_000,
    });

    // Yield so the kill() → killOnWindows → GCCE(CTRL_BREAK, pid)
    // chain runs. GCCE's implementation calls `triggerExit(0,
    // undefined)` synchronously, which fires the child's onExit
    // listener → cancels the escalation timer → resolves the
    // drainWaiter with "drained" via L631 (record.escalated === false).
    await Promise.resolve();
    await Promise.resolve();

    // Advance past the (now-cancelled) 2 s budget to confirm the
    // escalation timer was actually cancelled (a buggy implementation
    // that did NOT clear the timer would fire taskkill below).
    await vi.advanceTimersByTimeAsync(2_001);
    await Promise.resolve();
    await Promise.resolve();

    const result = await drainPromise;

    // Discriminator: the session counts under `sessionsDrained` (the
    // post-fix `escalated ? "forced" : "drained"` branch did NOT
    // over-classify the natural exit as forced).
    expect(result.sessionsDrained).toBe(1);
    expect(result.sessionsForcedKilled).toBe(0);

    // Load-bearing complement: `taskkill` was NEVER invoked. Without
    // this assertion, a future bug that over-eagerly fires taskkill
    // but still counts the natural exit as drained would pass above
    // vacuously.
    expect(winTaskkill).not.toHaveBeenCalled();

    // The natural `onExit(s-0, 0)` fired exactly once — the real
    // exit code, NOT the synthetic `1`.
    expect(winExitRecorder).toHaveBeenCalledTimes(1);
    expect(winExitRecorder).toHaveBeenCalledWith(expect.any(String), 0);
  });
});
