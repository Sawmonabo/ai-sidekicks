// `NodePtyHost.shutdown` counts each session drained or forced, is idempotent, skips sessions that
// already exited, and refuses every `spawn()` that races it, so no PTY child escapes the drain.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { NodePtyHost } from "../node-pty.js";
import type { ConsoleCtrlEvent, NodePtyChild, NodePtySpawnFn } from "../node-pty.js";
import type { TaskkillResult } from "../../taskkill-windows.js";
import { PtyBackendUnavailableError } from "../../sidecar/binary-path.js";
import { makeFakeChild, makeOrphanGuardDouble } from "../../__fixtures__/child-doubles.js";
import type { SpawnRequest } from "../protocol.js";
import type { DrainResult } from "../contract.js";
import { LINUX_TERMINAL_OPERATING_SYSTEM } from "../../operating-system/linux.js";
import { windowsTerminalOperatingSystem } from "../../operating-system/windows.js";

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
  // Fake timers: `shutdown()` races the drain waiter against a `deps.setTimer` timeout.
  vi.useFakeTimers();

  const spawnedChildren: ShutdownCtx["spawnedChildren"] = [];
  const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockImplementation(() => {
    // A fresh fake per spawn gives each session its own `onExit` closure.
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

  const host = new NodePtyHost(makeOrphanGuardDouble(), LINUX_TERMINAL_OPERATING_SYSTEM, {
    // POSIX, so `kill` takes the plain `child.kill(signal)` branch.
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

describe("NodePtyHost.shutdown — drain", () => {
  it(
    "is idempotent and re-entrant — a second " +
      "shutdown() call returns the same in-flight Promise",
    async () => {
      await ctx.host.spawn(SAMPLE_SPAWN);

      const firstPromise = ctx.host.shutdown({
        perSessionTimeoutMs: 2_000,
        hostTimeoutMs: 2_000,
      });
      const secondPromise = ctx.host.shutdown({
        perSessionTimeoutMs: 2_000,
        hostTimeoutMs: 2_000,
      });

      // The second call returns the same in-flight Promise (like `inflightSpawn` in
      // `RustSidecarPtyHost`).
      expect(secondPromise).toBe(firstPromise);

      await Promise.resolve();
      await Promise.resolve();
      ctx.spawnedChildren[0]!.triggerExit(0);

      const firstResult = await firstPromise;
      const secondResult = await secondPromise;
      expect(secondResult).toBe(firstResult);
    },
  );

  it("excludes already-exited sessions from both counters at shutdown entry", async () => {
    const spawnResp = await ctx.host.spawn(SAMPLE_SPAWN);

    // The session exits before `shutdown()`, which skips sessions that have already exited.
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
    // Three sessions: two exit gracefully and the third times out.
    await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.spawn(SAMPLE_SPAWN);
    expect(ctx.spawnedChildren).toHaveLength(3);

    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    // Sessions 0 and 1 exit gracefully; session 2 is left to time out.
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

  it("refuses spawn() once shutdown has started", async () => {
    // `shutdown()` sets `shuttingDown` before it snapshots the active sessions, so a `spawn()`
    // racing the drain is refused. Otherwise it would start a PTY child the drain never sees, and
    // `shutdown()` could resolve while that child still runs.

    await ctx.host.spawn(SAMPLE_SPAWN);
    expect(ctx.spawnedChildren).toHaveLength(1);

    // Start the drain without awaiting it: the gate must refuse spawns mid-drain, not only after.
    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    // One yield so the synchronous prefix of `runShutdown` has run (the flag is set before its
    // first await, so the gate would see it even without the yield).
    await Promise.resolve();

    // Rejects with `PtyBackendUnavailableError` for `node-pty`, and the message names the
    // terminal-host condition.
    const secondSpawnPromise = ctx.host.spawn(SAMPLE_SPAWN);
    await expect(secondSpawnPromise).rejects.toBeInstanceOf(PtyBackendUnavailableError);
    await expect(secondSpawnPromise).rejects.toMatchObject({
      details: { attemptedBackend: "node-pty" },
    });
    await expect(secondSpawnPromise).rejects.toThrow(/shutdown\(\)|terminal/);

    // The refused `spawn()` never reached `ptySpawn`; only the pre-shutdown session did.
    expect(ctx.ptySpawnStub).toHaveBeenCalledTimes(1);

    // Let the first session exit so the drain resolves.
    await Promise.resolve();
    ctx.spawnedChildren[0]!.triggerExit(0);
    await drainPromise;
  });

  it("refuses spawn() if shutdown() starts mid-resolvePtySpawn (post-await re-check)", async () => {
    // `spawn()` passes the entry gate, then yields on `await this.resolvePtySpawn()`. If
    // `shutdown()` starts in that gap, the re-check after the await must refuse the spawn before
    // `ptySpawn` runs; otherwise the new child escapes the drain snapshot.
    //
    // No session exists before shutdown, so `ptySpawn` must never be called: that shows the refusal
    // came from the re-check and not from the entry gate.

    // Start `spawn()` without awaiting it; it suspends on `resolvePtySpawn()`.
    const racingSpawnPromise = ctx.host.spawn(SAMPLE_SPAWN);

    // Call `shutdown()` before any microtask runs; it sets the flag before its first await.
    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 100,
      hostTimeoutMs: 100,
    });

    // `spawn()` resumes, sees the flag and throws; only the post-await re-check can catch this.
    await expect(racingSpawnPromise).rejects.toBeInstanceOf(PtyBackendUnavailableError);
    await expect(racingSpawnPromise).rejects.toMatchObject({
      details: { attemptedBackend: "node-pty" },
    });
    await expect(racingSpawnPromise).rejects.toThrow(/shutdown\(\)|terminal/);

    // `ptySpawn` was never called, so no orphan child was created.
    expect(ctx.ptySpawnStub).not.toHaveBeenCalled();

    // Nothing was registered, so the drain resolves with nothing to do.
    const result: DrainResult = await drainPromise;
    expect(result.sessionsDrained).toBe(0);
    expect(result.sessionsForcedKilled).toBe(0);
  });

  it("refuses spawn() after shutdown() has resolved", async () => {
    // Once `shutdown()` resolves the host stays terminal: `shuttingDown` never resets, so a later
    // `spawn()` gets the same error as during the drain.

    // A real session makes the drain do work before it resolves.
    await ctx.host.spawn(SAMPLE_SPAWN);
    expect(ctx.spawnedChildren).toHaveLength(1);

    const drainPromise = ctx.host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });

    // Let the session exit so the drain resolves.
    await Promise.resolve();
    await Promise.resolve();
    ctx.spawnedChildren[0]!.triggerExit(0);

    await drainPromise;

    // The gate sees `shuttingDown === true` and refuses before `ptySpawn` can run.
    const postShutdownSpawn = ctx.host.spawn(SAMPLE_SPAWN);
    await expect(postShutdownSpawn).rejects.toBeInstanceOf(PtyBackendUnavailableError);
    await expect(postShutdownSpawn).rejects.toMatchObject({
      details: { attemptedBackend: "node-pty" },
    });

    // `ptySpawn` ran only for the pre-shutdown session.
    expect(ctx.ptySpawnStub).toHaveBeenCalledTimes(1);
  });
});

// Windows: when the child ignores CTRL_BREAK_EVENT, the 2 s escalation timer runs taskkill before
// `perSessionTimeoutMs`, and the session must count as forced, not drained.

describe("NodePtyHost.shutdown — Windows taskkill-escalation race", () => {
  it(
    "counts a session under sessionsForcedKilled when the 2 s SIGTERM-escalation timer fires " +
      "before perSessionTimeoutMs",
    async () => {
      // The drain waiter carries "forced" from the synthetic exit that `invokeTaskkill` emits.
      const winSpawn = makeFakeChild(70000);
      const winPtySpawn: Mock<NodePtySpawnFn> = vi
        .fn<NodePtySpawnFn>()
        .mockReturnValue(winSpawn.child);
      // This CTRL_BREAK_EVENT sender does nothing (the child ignores it), so only the 2 s
      // escalation timer can resolve the drain.
      const winGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void> = vi.fn();
      const winTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
        .fn<(pid: number) => Promise<TaskkillResult>>()
        .mockResolvedValue({ exitCode: 0 });
      const winExitRecorder: Mock<
        (sessionId: string, exitCode: number, signalCode?: number) => void
      > = vi.fn();

      const winHost = new NodePtyHost(
        makeOrphanGuardDouble(),
        windowsTerminalOperatingSystem(undefined),
        {
          platform: "win32",
          ptySpawn: winPtySpawn,
          generateConsoleCtrlEvent: winGCCE,
          spawnTaskkill: winTaskkill,
        },
      );
      winHost.setOnExit(winExitRecorder);

      await winHost.spawn(SAMPLE_SPAWN);

      // 5 s exceeds the 2 s escalation timer in `killOnWindows`, so taskkill runs before the
      // per-session timeout; a shorter timeout would take the SIGKILL path instead.
      const drainPromise = winHost.shutdown({
        perSessionTimeoutMs: 5_000,
        hostTimeoutMs: 10_000,
      });

      // Let `kill()` return so `killOnWindows` arms the 2 s timer.
      await Promise.resolve();
      await Promise.resolve();

      // Before the 2 s budget: CTRL_BREAK_EVENT was sent and taskkill was not.
      expect(winGCCE).toHaveBeenCalledTimes(1);
      expect(winGCCE).toHaveBeenCalledWith(1, 70000);
      expect(winTaskkill).not.toHaveBeenCalled();

      // At 2 s the timer runs taskkill, which emits the synthetic exit and resolves the drain
      // waiter with "forced".
      await vi.advanceTimersByTimeAsync(2_001);
      await Promise.resolve();
      await Promise.resolve();

      const result = await drainPromise;

      // Counted as forced, not drained.
      expect(result.sessionsDrained).toBe(0);
      expect(result.sessionsForcedKilled).toBe(1);

      // taskkill must have run; otherwise a bug that only swapped the counters would pass.
      expect(winTaskkill).toHaveBeenCalledTimes(1);
      expect(winTaskkill).toHaveBeenCalledWith(70000);

      // The synthetic exit fired exactly once.
      expect(winExitRecorder).toHaveBeenCalledTimes(1);
      expect(winExitRecorder).toHaveBeenCalledWith(expect.any(String), 1);

      // In-process backend: host fields stay vacuous.
      expect(result.sidecarExitedCleanly).toBe(true);
      expect(result.taskkillEscalated).toBe(false);
    },
  );
});
