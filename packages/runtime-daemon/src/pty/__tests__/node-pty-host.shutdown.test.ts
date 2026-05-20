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
