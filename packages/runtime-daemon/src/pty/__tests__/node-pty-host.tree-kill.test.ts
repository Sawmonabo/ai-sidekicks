// Windows hard-stop tree-kill: `taskkill /T /F /PID` with a 2 s bounded escalation timer.
//
// - A SIGTERM whose child ignores CTRL_BREAK_EVENT escalates to `taskkill /T /F /PID <pid>` after
//   2 s; a single-PID kill leaves descendants orphaned on Windows (microsoft/node-pty#437).
// - The escalation is bounded: `onExit` fires even when the OS-level reap is incomplete, so a stuck
//   `taskkill` cannot hang the daemon.
// - Reaping is idempotent.
//
// Only the root PID is asserted: `/T` makes the OS walk the descendant tree, and the tree itself is
// not modeled here.

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

import type { SpawnRequest } from "@ai-sidekicks/contracts";

// Default pid 67890 differs from the kill-translation suite's 12345, so a failing assertion
// names the fixture. `makeFakeChild` comes from `_fakes.ts`.
const TREE_KILL_FIXTURE_PID = 67890;

const SAMPLE_SPAWN: SpawnRequest = {
  kind: "spawn_request",
  command: "cmd.exe",
  args: ["/c", "ping -t 127.0.0.1"], // a long-running command, in spirit
  env: [],
  cwd: "C:\\daemon-stable-parent",
  rows: 24,
  cols: 80,
};

interface TreeKillCtx {
  host: NodePtyHost;
  child: NodePtyChild;
  triggerExit: (exitCode: number, signal?: number) => void;
  mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void>;
  mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>>;
  ptySpawnStub: Mock<NodePtySpawnFn>;
  exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void>;
}

let ctx: TreeKillCtx;

beforeEach(() => {
  // Fake timers fire the 2 s escalation timer without waiting wall-clock seconds.
  vi.useFakeTimers();

  const { child, triggerExit } = makeFakeChild(TREE_KILL_FIXTURE_PID);
  // This CTRL_BREAK_EVENT sender does nothing: the child ignores it, so the escalation timer
  // runs taskkill.
  const mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void> = vi.fn();
  const mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
    .fn<(pid: number) => Promise<TaskkillResult>>()
    .mockResolvedValue({ exitCode: 0 });
  const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
  const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
    vi.fn();

  const host = new NodePtyHost({
    platform: "win32",
    ptySpawn: ptySpawnStub,
    generateConsoleCtrlEvent: mockGCCE,
    spawnTaskkill: mockTaskkill,
  });
  host.setOnExit(exitRecorder);

  ctx = {
    host,
    child,
    triggerExit,
    mockGCCE,
    mockTaskkill,
    ptySpawnStub,
    exitRecorder,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

// 2 s escalation, tree-kill and onExit emission

describe("NodePtyHost — hard-stop escalation to taskkill /T /F", () => {
  it("SIGTERM whose child ignores CTRL_BREAK_EVENT escalates to taskkill at the 2 s budget and emits onExit regardless of OS reap status", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // The graceful kill arms a 2 s timer and returns without waiting for it.
    await ctx.host.kill(session_id, "SIGTERM");

    // T+0: CTRL_BREAK_EVENT was sent (the sender is a no-op here).
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, 67890);

    // Before the budget, taskkill has not run.
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // Just under the budget: still no escalation.
    await vi.advanceTimersByTimeAsync(1999);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // Crossing 2 s fires the timer and starts `invokeTaskkill`; the async advance also drains
    // microtasks, so the taskkill mock resolves and `onExit` is observable.
    await vi.advanceTimersByTimeAsync(1);

    // taskkill gets the root PID; the production spawn adds `/T /F`, and the injected mock
    // receives only the pid.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(67890);

    // `onExit` fires even though the OS-level reap is opaque (a failing taskkill also emits; see
    // the next tests).
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    const [emittedSessionId, emittedExitCode] = ctx.exitRecorder.mock.calls[0]!;
    expect(emittedSessionId).toBe(session_id);
    expect(emittedExitCode).toBe(1);
  });

  it("if the child exits BEFORE the 2 s budget elapses, the escalation is canceled and taskkill is never called", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.kill(session_id, "SIGTERM");

    // The child answers CTRL_BREAK_EVENT at T+1s; the `onExit` subscription from `spawn()` clears
    // the escalation timer.
    await vi.advanceTimersByTimeAsync(1000);
    ctx.triggerExit(0);

    // Run out the original budget: the timer was cleared, so taskkill stays uncalled.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // One onExit, from the child's own exit.
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(session_id, 0);
  });

  it("emits onExit even when taskkill itself fails (OS-level reap stalled)", async () => {
    // A rejecting taskkill must not stop the synthetic onExit.
    ctx.mockTaskkill.mockRejectedValueOnce(new Error("taskkill: access denied"));

    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.kill(session_id, "SIGTERM");
    await vi.advanceTimersByTimeAsync(2000);

    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(67890);

    // onExit still fires, so the session is marked terminated whatever the OS-level reap outcome.
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(session_id, 1);
  });

  it("SIGKILL bypasses the 2 s budget and invokes taskkill immediately", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.kill(session_id, "SIGKILL");

    // SIGKILL runs `taskkill /T /F /PID` directly; `host.kill` was awaited, so the mock has
    // resolved.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(67890);

    // SIGKILL skips the graceful CTRL_BREAK_EVENT step.
    expect(ctx.mockGCCE).not.toHaveBeenCalled();

    // onExit fires immediately, without the 2 s wait.
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(session_id, 1);
  });
});

// A real OS exit arriving after the synthetic taskkill exit (exitCode 1) must neither re-fire
// onExit nor overwrite the cached code, so a later `kill()` re-emits the code the consumer first
// saw. This also covers the de-dupe branch in `child.onExit`.

describe("NodePtyHost — synthetic-exit cache is write-once", () => {
  it("post-synthetic-exit OS exit does not re-fire and does not mutate the cache; subsequent kill() re-emits the synthetic exitCode", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: SIGTERM arms the 2 s escalation timer.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, 67890);

    // T+2s: the timer runs taskkill, then the synthetic onExit(1) is emitted.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenNthCalledWith(1, session_id, 1);

    // The real OS exit arrives with code 0; it must not re-fire onExit or change the cached code.
    ctx.triggerExit(0);

    // Only one onExit so far: the real exit was de-duped in `child.onExit`.
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);

    // A later kill() re-emits from the cache, and the cached code must still be the synthetic 1;
    // otherwise consumers would see an inconsistent exit history.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(2);
    expect(ctx.exitRecorder).toHaveBeenNthCalledWith(2, session_id, 1);

    // The re-emit must not send CTRL_BREAK_EVENT or run taskkill again.
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1); // only the original SIGTERM
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1); // only the original escalation
  });
});

// Preemption: `killOnWindows` clears the pending escalation timer at the top of every branch.
// A stale SIGTERM timer would otherwise run `taskkill` a second time, possibly on a recycled PID
// (the user clicks Stop and then Force Stop in quick succession).

describe("NodePtyHost — preemption clears stale escalation timer", () => {
  it("SIGKILL after SIGTERM clears the pending 2 s escalation timer; mockTaskkill fires exactly once", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: SIGTERM arms the 2 s timer.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // T+1s: still inside the budget.
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // SIGKILL at T+1s must cancel the SIGTERM timer via `clearPendingEscalation`; otherwise the
    // timer would run taskkill again at T+2s.
    await ctx.host.kill(session_id, "SIGKILL");
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);

    // Run past the original SIGTERM's 2 s escalation point.
    await vi.advanceTimersByTimeAsync(1500);

    // taskkill ran exactly once (from SIGKILL); a second call would be the orphaned SIGTERM timer.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(67890);
  });

  it("two consecutive SIGTERMs arm only one live timer; mockTaskkill fires once at T+2s of the SECOND arming", async () => {
    // Repeated SIGTERMs: the second must clear the first timer before arming its own.
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: the first SIGTERM arms timer A (fires at T+2s).
    await ctx.host.kill(session_id, "SIGTERM");

    // T+1s: the second SIGTERM clears timer A and arms timer B (fires at T+3s). An uncleared A
    // would run taskkill at T+2s as well as B at T+3s.
    await vi.advanceTimersByTimeAsync(1000);
    await ctx.host.kill(session_id, "SIGTERM");

    // T+2s: A was cleared, so taskkill has not run.
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // T+3s: timer B fires once.
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);

    // Well past when an orphaned timer would have fired: still one call.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
  });

  it("SIGINT after SIGTERM clears the pending escalation timer; mockTaskkill never fires", async () => {
    // SIGINT after SIGTERM.
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);

    // SIGINT clears the SIGTERM timer before its own translation runs.
    await ctx.host.kill(session_id, "SIGINT");

    // Run past the original SIGTERM's 2 s escalation point.
    await vi.advanceTimersByTimeAsync(2000);

    // SIGINT does not escalate to taskkill, and the SIGTERM timer was cleared.
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    // SIGINT translation: CTRL_C_EVENT after CTRL_BREAK_EVENT.
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(2);
    expect(ctx.mockGCCE).toHaveBeenNthCalledWith(1, 1, 67890); // SIGTERM
    expect(ctx.mockGCCE).toHaveBeenNthCalledWith(2, 0, 67890); // SIGINT
  });
});

// `invokeTaskkill` races `spawnTaskkill(pid)` against a 5 s fallback timer (built on the same
// `setTimer`/`clearTimer` as the 2 s escalation), so a stuck OS-level taskkill cannot keep
// `onExit` from firing.

describe("NodePtyHost — invokeTaskkill is wall-clock bounded", () => {
  it("SIGKILL with a never-resolving spawnTaskkill still fires onExit after the 5 s fallback timeout", async () => {
    // A `spawnTaskkill` that never settles.
    const { child } = makeFakeChild(12321);
    const neverResolves: Promise<TaskkillResult> = new Promise<TaskkillResult>(() => {
      // intentionally empty — the promise never settles.
    });
    const stuckTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
      .fn<(pid: number) => Promise<TaskkillResult>>()
      .mockReturnValue(neverResolves);
    const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
    const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
      vi.fn();

    const host = new NodePtyHost({
      platform: "win32",
      ptySpawn: ptySpawnStub,
      // The SIGKILL path never calls the console-control sender; a no-op keeps the host from
      // loading the production FFI.
      generateConsoleCtrlEvent: vi.fn(),
      spawnTaskkill: stuckTaskkill,
    });
    host.setOnExit(exitRecorder);

    const { session_id } = await host.spawn(SAMPLE_SPAWN);

    // Not awaited: the kill returns only after the race settles, and the fake timer must be
    // advanced first.
    const killPromise = host.kill(session_id, "SIGKILL");

    // `spawnTaskkill` was called at once, but the race has not settled, so no onExit.
    expect(stuckTaskkill).toHaveBeenCalledTimes(1);
    expect(stuckTaskkill).toHaveBeenCalledWith(12321);
    expect(exitRecorder).not.toHaveBeenCalled();

    // Just under the fallback budget: still pending.
    await vi.advanceTimersByTimeAsync(4999);
    expect(exitRecorder).not.toHaveBeenCalled();

    // At 5 s the fallback wins and the synthetic onExit is emitted.
    await vi.advanceTimersByTimeAsync(1);
    await killPromise;

    // onExit fires with the synthetic code 1 although the OS-level reap never completed.
    expect(exitRecorder).toHaveBeenCalledTimes(1);
    expect(exitRecorder).toHaveBeenCalledWith(session_id, 1);
  });
});

// `invokeTaskkill` awaits `spawnTaskkill` (or the 5 s fallback) and captures `record` and
// `sessionId`. If `close()` runs during that await, `sessions.delete` removes the entry but the
// closure still holds the record, so the synthetic `onExit` must be gated on
// `this.sessions.has(sessionId)`.
//
// Each race shape gets its own test, since a separate fast path could bypass the shared gate:
//   * SIGTERM, 2 s timer, taskkill in flight, close, resolve
//   * SIGKILL, taskkill in flight, close, resolve
//   * 5 s fallback fires after close

describe("NodePtyHost — synthetic onExit gated on live session", () => {
  it("SIGTERM: close() during 2 s escalation IIFE suppresses the synthetic onExit when spawnTaskkill resolves post-close", async () => {
    // Hold taskkill open so `close()` can run between the await starting and resolving.
    let resolveTaskkill!: (value: TaskkillResult) => void;
    const taskkillPromise: Promise<TaskkillResult> = new Promise<TaskkillResult>((res) => {
      resolveTaskkill = res;
    });
    ctx.mockTaskkill.mockReturnValueOnce(taskkillPromise);

    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: SIGTERM arms the 2 s escalation timer.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, TREE_KILL_FIXTURE_PID);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // T+2s: the timer runs `invokeTaskkill`, which awaits the held-open taskkill.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(TREE_KILL_FIXTURE_PID);
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // The consumer cancels mid-flight; the session leaves `sessions`.
    await ctx.host.close(session_id);

    // Releasing taskkill returns control to the synthetic-emit block, where the `sessions.has`
    // gate must suppress onExit.
    resolveTaskkill({ exitCode: 0 });

    // Flush microtasks so the post-await block runs.
    await vi.runAllTimersAsync();

    // No onExit on the closed session.
    expect(ctx.exitRecorder).not.toHaveBeenCalled();
  });

  it("SIGKILL: close() during the direct invokeTaskkill IIFE suppresses the synthetic onExit when spawnTaskkill resolves post-close", async () => {
    // SIGKILL skips the 2 s step; the same close-mid-flight race applies.
    let resolveTaskkill!: (value: TaskkillResult) => void;
    const taskkillPromise: Promise<TaskkillResult> = new Promise<TaskkillResult>((res) => {
      resolveTaskkill = res;
    });
    ctx.mockTaskkill.mockReturnValueOnce(taskkillPromise);

    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // Not awaited: `invokeTaskkill` is in flight on the held-open taskkill.
    const killPromise: Promise<void> = ctx.host.kill(session_id, "SIGKILL");

    // taskkill was called at once; nothing else has happened.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(TREE_KILL_FIXTURE_PID);
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // The consumer cancels mid-flight.
    await ctx.host.close(session_id);

    // Releasing taskkill must not emit on the closed session.
    resolveTaskkill({ exitCode: 0 });
    await vi.runAllTimersAsync();
    await killPromise;

    // No onExit on the closed session.
    expect(ctx.exitRecorder).not.toHaveBeenCalled();
  });

  it("5 s fallback race: close() during a never-resolving spawnTaskkill suppresses the synthetic onExit when the fallback timer wins", async () => {
    // A dedicated host whose taskkill never settles: `close()` lands during the wait, the 5 s
    // fallback then wins the race, and the gate must still suppress the emit.
    const { child } = makeFakeChild(45678);
    const neverResolves: Promise<TaskkillResult> = new Promise<TaskkillResult>(() => {
      // intentionally empty — the promise never settles.
    });
    const stuckTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
      .fn<(pid: number) => Promise<TaskkillResult>>()
      .mockReturnValue(neverResolves);
    const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
    const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
      vi.fn();

    const host = new NodePtyHost({
      platform: "win32",
      ptySpawn: ptySpawnStub,
      generateConsoleCtrlEvent: vi.fn(),
      spawnTaskkill: stuckTaskkill,
    });
    host.setOnExit(exitRecorder);

    const { session_id } = await host.spawn(SAMPLE_SPAWN);

    // SIGKILL waits on the never-settling taskkill against the 5 s fallback.
    const killPromise: Promise<void> = host.kill(session_id, "SIGKILL");
    expect(stuckTaskkill).toHaveBeenCalledTimes(1);

    // Partway through the 5 s budget.
    await vi.advanceTimersByTimeAsync(2500);

    // The consumer cancels at T+2.5s, before the fallback fires.
    await host.close(session_id);

    // At 5 s the fallback wins and control reaches the synthetic-emit block, where the gate must
    // suppress the emit.
    await vi.advanceTimersByTimeAsync(2500);
    await killPromise;

    // No onExit on the closed session.
    expect(exitRecorder).not.toHaveBeenCalled();
  });
});

// `node-pty` `kill()` on Windows signals one PID and does not walk the process tree, so routing
// `close()` through `record.child.kill()` would orphan descendants. On Windows `close()` instead
// runs the same `taskkill /T /F /PID` as `kill(SIGKILL)`, without waiting for the reap. The
// synthetic `onExit` is suppressed because `close()` deletes the session right after dispatching:
// closing means the consumer wants no more events.

describe("NodePtyHost — close() on Windows routes through taskkill", () => {
  it("close() on Windows invokes taskkill (not record.child.kill); descendants are reaped via /T /F", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // Clear the spy (the fake child's `kill` is a `vi.fn()` from `_fakes.ts`); close() must not
    // call it on Windows.
    const childKillSpy: Mock = ctx.child.kill as unknown as Mock;
    childKillSpy.mockClear();

    // Before close, taskkill has not run.
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    await ctx.host.close(session_id);

    // close() ran `taskkill /T /F /PID` with the session's root pid; `/T` (set in
    // `defaultSpawnTaskkill`) walks the descendants.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(TREE_KILL_FIXTURE_PID);

    // node-pty's `kill` is the path that orphans descendants, so it must not be used.
    expect(childKillSpy).not.toHaveBeenCalled();

    // No synthetic onExit: `close()` deleted the session before the emit block ran, and closing
    // means no more events.
    await vi.runAllTimersAsync();
    expect(ctx.exitRecorder).not.toHaveBeenCalled();
  });

  it("close() on POSIX still uses record.child.kill() — the fix is scoped to Windows", async () => {
    // A POSIX host: `record.child.kill()` signals the session leader and the TTY foreground
    // process group carries the signal to descendants, so POSIX has no orphan hazard.
    const { child } = makeFakeChild(54321);
    const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
    const mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
      .fn<(pid: number) => Promise<TaskkillResult>>()
      .mockResolvedValue({ exitCode: 0 });
    const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
      vi.fn();

    const host = new NodePtyHost({
      platform: "linux",
      ptySpawn: ptySpawnStub,
      spawnTaskkill: mockTaskkill,
    });
    host.setOnExit(exitRecorder);

    const { session_id } = await host.spawn(SAMPLE_SPAWN);
    const childKillSpy: Mock = child.kill as unknown as Mock;
    childKillSpy.mockClear();

    await host.close(session_id);

    // POSIX: child.kill() is called once.
    expect(childKillSpy).toHaveBeenCalledTimes(1);

    // taskkill is Windows-only.
    expect(mockTaskkill).not.toHaveBeenCalled();
  });

  it("close() during in-flight SIGTERM clears the escalation timer; only the close-dispatched taskkill fires", async () => {
    // SIGTERM arms the 2 s timer and close() lands at T+1s; `clearPendingEscalation` in close()
    // cancels it, so only close's own taskkill runs and no second taskkill fires 2 s later on the
    // same pid.
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: SIGTERM sends CTRL_BREAK_EVENT and arms the 2 s timer.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, TREE_KILL_FIXTURE_PID);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // T+1s: still inside the budget.
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // close() cancels the SIGTERM timer and dispatches its own taskkill.
    await ctx.host.close(session_id);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(TREE_KILL_FIXTURE_PID);

    // Past the original 2 s point the canceled timer must not run taskkill again.
    await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
  });
});

// `KillResponse` acks once the kill cascade has begun, not when the child has exited;
// `ExitCodeNotification` carries the terminal status. So `kill(SIGKILL)` must not await
// `invokeTaskkill`, which waits up to 5 s on its fallback timer when `spawnTaskkill` never settles.

describe("NodePtyHost — kill(SIGKILL) returns once cascade has BEGUN", () => {
  it("kill(SIGKILL) with a never-resolving spawnTaskkill resolves before the 5 s fallback fires", async () => {
    // Hold taskkill open. If `kill()` awaited `invokeTaskkill`, the `await kill()` below would
    // block until the 5 s fallback; it must resolve at once because `spawnTaskkill` is invoked
    // before the first await.
    let resolveTaskkill!: (value: TaskkillResult) => void;
    const taskkillPromise: Promise<TaskkillResult> = new Promise<TaskkillResult>((res) => {
      resolveTaskkill = res;
    });
    ctx.mockTaskkill.mockReturnValueOnce(taskkillPromise);

    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // Flips once `kill()` resolves; the fake timers are never advanced, so a blocked kill() would
    // leave it false.
    let killResolved = false;
    const killP: Promise<void> = ctx.host.kill(session_id, "SIGKILL").then(() => {
      killResolved = true;
    });

    // Cascade begun: `spawnTaskkill` was invoked synchronously.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(TREE_KILL_FIXTURE_PID);

    // No synthetic onExit yet: `invokeTaskkill` is still waiting on the held-open taskkill.
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // Only microtasks drain here; kill() must resolve without any fake-timer advance.
    await killP;

    // kill() resolved before the 5 s fallback could fire.
    expect(killResolved).toBe(true);

    // The fallback has not fired early, so no onExit.
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // Releasing taskkill now emits the synthetic onExit (the session is still open, so the gate
    // passes).
    resolveTaskkill({ exitCode: 0 });
    await vi.runAllTimersAsync();

    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(session_id, 1);
  });

  it("kill(SIGKILL) returns before spawnTaskkill resolves; cascade-begun ack is honored", async () => {
    // Stricter ordering check: with a controllable taskkill, kill() must resolve before
    // `spawnTaskkill` resolves; the ack means the cascade began, not that it finished.
    let resolveTaskkill!: (value: TaskkillResult) => void;
    const taskkillPromise: Promise<TaskkillResult> = new Promise<TaskkillResult>((res) => {
      resolveTaskkill = res;
    });
    ctx.mockTaskkill.mockReturnValueOnce(taskkillPromise);

    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // Record the order in which the promises resolve.
    const order: Array<string> = [];
    const killP: Promise<void> = ctx.host.kill(session_id, "SIGKILL").then(() => {
      order.push("kill-resolved");
    });
    void taskkillPromise.then(() => {
      order.push("taskkill-resolved");
    });

    // Only microtasks drain; kill() resolves because the cascade has begun.
    await killP;

    expect(order).toEqual(["kill-resolved"]);

    // Resolving taskkill after kill() has returned shows the cascade-begun ack.
    resolveTaskkill({ exitCode: 0 });
    await vi.runAllTimersAsync();

    expect(order).toEqual(["kill-resolved", "taskkill-resolved"]);
  });
});
