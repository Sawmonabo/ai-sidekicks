// `NodePtyHost` kill and close: the Windows translation (SIGINT to CTRL_C_EVENT, SIGTERM and SIGHUP
// to CTRL_BREAK_EVENT then `taskkill /T /F` after 2 s, SIGKILL to `taskkill /T /F`), the bounded
// reap, the POSIX pass-through, and a close that ends the child through the operating system and
// waits for its exit, a real program that ignores the hangup and the stop included. Only the root
// PID is asserted; `/T` makes the OS walk the tree.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { NodePtyHost } from "../node-pty.js";
import type { ConsoleCtrlEvent } from "../../console-control-windows.js";
import type { NodePtyChild, NodePtySpawnFn } from "../node-pty.js";
import type { TaskkillResult } from "../../taskkill-windows.js";
import { makeFakeChild, makeOrphanGuardDouble } from "../../__fixtures__/child-doubles.js";
import { SPAWN_NONCE_ENVIRONMENT_NAME } from "../../orphan/registry.js";
import type { SpawnRequest } from "../protocol.js";
import type { TerminalOperatingSystem } from "../../operating-system/contract.js";
import { LINUX_TERMINAL_OPERATING_SYSTEM } from "../../operating-system/linux.js";
import { windowsTerminalOperatingSystem } from "../../operating-system/windows.js";

// Distinctive, so a failing assertion names the fixture.
const FIXTURE_PID = 67890;

const SAMPLE_SPAWN: SpawnRequest = {
  kind: "spawn_request",
  command: "cmd.exe",
  args: ["/c", "ping -t 127.0.0.1"], // a long-running command, in spirit
  env: [],
  cwd: "C:\\daemon-stable-parent",
  rows: 24,
  cols: 80,
};

interface KillCtx {
  host: NodePtyHost;
  child: NodePtyChild;
  triggerExit: (exitCode: number, signal?: number) => void;
  mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void>;
  mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>>;
  ptySpawnStub: Mock<NodePtySpawnFn>;
  exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void>;
  /** The operating system's ending of a child, which ends the fake child at once. */
  endTerminalChild: Mock<TerminalOperatingSystem["endTerminalChild"]>;
}

let ctx: KillCtx;

beforeEach(() => {
  // Fake timers fire the 2 s escalation timer without waiting wall-clock seconds.
  vi.useFakeTimers();

  const { child, triggerExit } = makeFakeChild(FIXTURE_PID);
  // This CTRL_BREAK_EVENT sender does nothing: the child ignores it, so the escalation timer
  // runs taskkill.
  const mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void> = vi.fn();
  const mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
    .fn<(pid: number) => Promise<TaskkillResult>>()
    .mockResolvedValue({ exitCode: 0 });
  const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
  const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
    vi.fn();

  const endTerminalChild = vi.fn<TerminalOperatingSystem["endTerminalChild"]>(() => {
    triggerExit(1);
  });

  const host = new NodePtyHost(
    makeOrphanGuardDouble(),
    { ...windowsTerminalOperatingSystem(undefined), endTerminalChild },
    {
      platform: "win32",
      ptySpawn: ptySpawnStub,
      generateConsoleCtrlEvent: mockGCCE,
      spawnTaskkill: mockTaskkill,
    },
  );
  host.setOnExit(exitRecorder);

  ctx = {
    host,
    child,
    triggerExit,
    mockGCCE,
    mockTaskkill,
    ptySpawnStub,
    exitRecorder,
    endTerminalChild,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

// 2 s escalation, tree-kill and onExit emission

describe("NodePtyHost — hard-stop escalation to taskkill /T /F", () => {
  // SIGHUP takes the SIGTERM path on Windows.
  it.each(["SIGTERM", "SIGHUP"] as const)(
    "%s whose child ignores CTRL_BREAK_EVENT escalates to taskkill at the 2 s budget and " +
      "emits onExit regardless of OS reap status",
    async (signal) => {
      const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

      // The graceful kill arms a 2 s timer and returns without waiting for it.
      await ctx.host.kill(session_id, signal);

      // T+0: CTRL_BREAK_EVENT was sent (the sender is a no-op here).
      expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
      expect(ctx.mockGCCE).toHaveBeenCalledWith(1, FIXTURE_PID);

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
      expect(ctx.mockTaskkill).toHaveBeenCalledWith(FIXTURE_PID);

      // `onExit` fires even though the OS-level reap is opaque (a failing taskkill also emits; see
      // the next tests).
      expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
      const [emittedSessionId, emittedExitCode] = ctx.exitRecorder.mock.calls[0]!;
      expect(emittedSessionId).toBe(session_id);
      expect(emittedExitCode).toBe(1);
    },
  );

  it(
    "if the child exits BEFORE the 2 s budget elapses, the escalation is canceled and taskkill " +
      "is never called",
    async () => {
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
    },
  );

  it("emits onExit even when taskkill itself fails (OS-level reap stalled)", async () => {
    // A rejecting taskkill must not stop the synthetic onExit.
    ctx.mockTaskkill.mockRejectedValueOnce(new Error("taskkill: access denied"));

    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.kill(session_id, "SIGTERM");
    await vi.advanceTimersByTimeAsync(2000);

    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(FIXTURE_PID);

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
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(FIXTURE_PID);

    // SIGKILL skips the graceful CTRL_BREAK_EVENT step.
    expect(ctx.mockGCCE).not.toHaveBeenCalled();

    // onExit fires immediately, without the 2 s wait.
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(session_id, 1);
  });
});

// A real OS exit arriving after the synthetic taskkill exit (exitCode 1) must not fire onExit a
// second time, and a later `kill()` must not either: the exit is reported exactly once. This also
// covers the de-dupe branch in `child.onExit`.

describe("NodePtyHost — the synthetic exit is reported exactly once", () => {
  it("neither the post-synthetic OS exit nor a later kill() fires onExit again", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: SIGTERM arms the 2 s escalation timer.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, FIXTURE_PID);

    // T+2s: the timer runs taskkill, then the synthetic onExit(1) is emitted.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenNthCalledWith(1, session_id, 1);

    // The real OS exit arrives with code 0; it must not fire onExit again.
    ctx.triggerExit(0);

    // Only one onExit so far: the real exit was de-duped in `child.onExit`.
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);

    // A later kill() sends nothing and reports nothing.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);

    // It must not send CTRL_BREAK_EVENT or run taskkill again.
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1); // only the original SIGTERM
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1); // only the original escalation
  });
});

// `invokeTaskkill` races `spawnTaskkill(pid)` against a 5 s fallback timer (built on the same
// `setTimer`/`clearTimer` as the 2 s escalation), so a stuck OS-level taskkill cannot keep
// `onExit` from firing.

describe("NodePtyHost — invokeTaskkill is wall-clock bounded", () => {
  it(
    "SIGKILL with a never-resolving spawnTaskkill still fires onExit after the 5 s fallback " +
      "timeout",
    async () => {
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

      const host = new NodePtyHost(
        makeOrphanGuardDouble(),
        windowsTerminalOperatingSystem(undefined),
        {
          platform: "win32",
          ptySpawn: ptySpawnStub,
          // The SIGKILL path never calls the console-control sender; a no-op keeps the host from
          // loading the production FFI.
          generateConsoleCtrlEvent: vi.fn(),
          spawnTaskkill: stuckTaskkill,
        },
      );
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
    },
  );
});

// `invokeTaskkill` awaits `spawnTaskkill` (or the 5 s fallback) and captures `record` and
// `sessionId`. If `close()` runs during that await, `sessions.delete` removes the entry but the
// closure still holds the record, so the synthetic `onExit` must be gated on
// `this.sessions.has(sessionId)`. The SIGTERM escalation and the 5 s fallback reach the same gate.

describe("NodePtyHost — synthetic onExit gated on live session", () => {
  it(
    "SIGKILL: close() during the direct invokeTaskkill IIFE suppresses the synthetic onExit " +
      "when spawnTaskkill resolves post-close",
    async () => {
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
      expect(ctx.mockTaskkill).toHaveBeenCalledWith(FIXTURE_PID);
      expect(ctx.exitRecorder).not.toHaveBeenCalled();

      // The consumer cancels mid-flight.
      await ctx.host.close(session_id);

      // Releasing taskkill must not emit on the closed session.
      resolveTaskkill({ exitCode: 0 });
      await vi.runAllTimersAsync();
      await killPromise;

      // No onExit on the closed session.
      expect(ctx.exitRecorder).not.toHaveBeenCalled();
    },
  );
});

// A close ends the child through the operating system, never through `node-pty`'s own kill, which
// on Windows orphans descendants, and resolves once the child has exited; closing means the
// consumer wants no more events, so neither the child's exit nor a synthetic one is reported.

describe("NodePtyHost — close() ends the child and waits for its exit", () => {
  it("asks the child to hang up through the operating system and reports nothing", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.close(session_id);

    expect(ctx.endTerminalChild.mock.calls).toEqual([[ctx.child, "hangup"]]);
    expect(ctx.child.kill).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(ctx.exitRecorder).not.toHaveBeenCalled();
  });

  it("close() during in-flight SIGTERM clears the escalation timer, so no stale taskkill fires", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: SIGTERM sends CTRL_BREAK_EVENT and arms the 2 s timer; close lands at T+1s.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, FIXTURE_PID);
    await vi.advanceTimersByTimeAsync(1000);
    await ctx.host.close(session_id);

    // Past the original 2 s point the canceled timer must not run taskkill on the pid.
    await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
  });

  it("stops then kills a child that withstands each ending, and throws when it outlives its kill", async () => {
    const { child } = makeFakeChild(54321);
    const endTerminalChild = vi.fn<TerminalOperatingSystem["endTerminalChild"]>();
    const host = new NodePtyHost(
      makeOrphanGuardDouble(),
      { ...LINUX_TERMINAL_OPERATING_SYSTEM, endTerminalChild },
      { platform: "linux", ptySpawn: vi.fn<NodePtySpawnFn>().mockReturnValue(child) },
    );
    const { session_id } = await host.spawn(SAMPLE_SPAWN);

    const closing = host.close(session_id);
    const refusal = expect(closing).rejects.toThrow("process 54321, did not end when killed");
    await vi.advanceTimersByTimeAsync(5999);
    expect(endTerminalChild.mock.calls.map(([, ending]) => ending)).toEqual([
      "hangup",
      "stop",
      "kill",
    ]);
    await vi.advanceTimersByTimeAsync(1);
    await refusal;
  });
});

describe.skipIf(process.platform === "win32")("NodePtyHost — close() of a real program", () => {
  it("ends one that ignores the hangup and the stop, resolving only once it is gone", async () => {
    vi.useRealTimers();
    const host = new NodePtyHost(makeOrphanGuardDouble(), LINUX_TERMINAL_OPERATING_SYSTEM, {
      endingStepMs: 200,
    });
    // The program prints its own process id once its traps are set; `exec` keeps the id and the
    // ignored signals.
    const printed = Promise.withResolvers<number>();
    let output = "";
    host.setOnData((_sessionId, chunk) => {
      output += new TextDecoder().decode(chunk);
      const match = /pid (\d+)/.exec(output);
      if (match?.[1] !== undefined) {
        printed.resolve(Number(match[1]));
      }
    });
    const { session_id } = await host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: ["-c", "trap '' HUP TERM; echo pid $$; exec sleep 60"],
      env: [["PATH", "/usr/bin:/bin"]],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    const programPid = await printed.promise;

    const startedAt = performance.now();
    await host.close(session_id);

    // The hangup and the stop each waited their step out; the kill ended it.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(400);
    expect(() => process.kill(programPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }, 15_000);
});

// `KillResponse` acks once the kill cascade has begun, not when the child has exited;
// `ExitCodeNotification` carries the terminal status. So `kill(SIGKILL)` must not await
// `invokeTaskkill`, which waits up to 5 s on its fallback timer when `spawnTaskkill` never settles.

describe("NodePtyHost — kill(SIGKILL) returns once cascade has BEGUN", () => {
  it(
    "kill(SIGKILL) with a never-resolving spawnTaskkill " +
      "resolves before the 5 s fallback fires",
    async () => {
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
      expect(ctx.mockTaskkill).toHaveBeenCalledWith(FIXTURE_PID);

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
    },
  );
});

// SIGINT, a kill after exit, and the POSIX pass-through.

describe("NodePtyHost — kill translation", () => {
  it(
    "SIGINT invokes GenerateConsoleCtrlEvent(CTRL_C_EVENT=0, child.pid) and does NOT call " +
      "taskkill",
    async () => {
      const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

      await ctx.host.kill(session_id, "SIGINT");

      // SIGINT must translate to `CTRL_C_EVENT=0`, not `CTRL_BREAK_EVENT=1` or `process.kill`.
      expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
      expect(ctx.mockGCCE).toHaveBeenCalledWith(0, FIXTURE_PID);

      // SIGINT never touches the hard-stop path.
      expect(ctx.mockTaskkill).not.toHaveBeenCalled();

      // Windows never delegates to node-pty's own `kill()`, which does not reach the process
      // tree (`microsoft/node-pty#167`).
      expect(ctx.child.kill).not.toHaveBeenCalled();
    },
  );

  it("kill() on an exited session fires no second onExit and does NOT call any FFI", async () => {
    // A taskkill on an exited child's pid could reach an unrelated process that reused it.
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // The child exits on its own; the `onExit` subscription from `spawn()` reports it.
    ctx.triggerExit(0);

    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(session_id, 0);

    await ctx.host.kill(session_id, "SIGTERM");

    // Exactly one fire: the child's own exit.
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);

    // No FFI call, no taskkill, no node-pty kill.
    expect(ctx.mockGCCE).not.toHaveBeenCalled();
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    expect(ctx.child.kill).not.toHaveBeenCalled();
  });

  it("on platform=linux, SIGINT delegates to child.kill('SIGINT')", async () => {
    const { child } = makeFakeChild();
    const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
    const host = new NodePtyHost(makeOrphanGuardDouble(), LINUX_TERMINAL_OPERATING_SYSTEM, {
      platform: "linux",
      ptySpawn: ptySpawnStub,
    });

    const { session_id } = await host.spawn(SAMPLE_SPAWN);
    await host.kill(session_id, "SIGINT");

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
  });
});

describe("NodePtyHost — spawn, resize and write", () => {
  it("calls node-pty.spawn with the requested command/args and translated env record", async () => {
    const spec: SpawnRequest = {
      ...SAMPLE_SPAWN,
      env: [
        ["PATH", "/usr/bin"],
        ["FOO", "bar"],
      ],
    };
    await ctx.host.spawn(spec);

    expect(ctx.ptySpawnStub).toHaveBeenCalledTimes(1);
    const [command, args, options] = ctx.ptySpawnStub.mock.calls[0]!;
    expect(command).toBe("cmd.exe");
    expect(args).toEqual(["/c", "ping -t 127.0.0.1"]);
    // node-pty takes an env record, not tuples, and the child carries its registry nonce.
    expect(options.env).toEqual({
      PATH: "/usr/bin",
      FOO: "bar",
      [SPAWN_NONCE_ENVIRONMENT_NAME]: "nonce-1",
    });
    // `useConptyDll` must stay `false`.
    expect(options.useConptyDll).toBe(false);
  });

  it("resize/write delegate to the underlying child and reject unknown session-ids", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.resize(session_id, 40, 120);
    expect(ctx.child.resize).toHaveBeenCalledWith(120, 40); // (cols, rows)

    // A write answers once the terminal has taken every byte, and fails with the terminal.
    const callbacks: ((error?: Error) => void)[] = [];
    vi.mocked(ctx.child.write).mockImplementation((_data, callback) => {
      callbacks.push(callback);
    });
    const payload = new Uint8Array([0x68, 0x69]); // "hi"
    let isWritten = false;
    const writing = ctx.host.write(session_id, payload).then(() => {
      isWritten = true;
    });
    await Promise.resolve();
    expect(ctx.child.write).toHaveBeenCalledWith(payload, expect.any(Function));
    expect(isWritten).toBe(false);
    callbacks[0]?.();
    await writing;
    const failing = ctx.host.write(session_id, payload);
    callbacks[1]?.(new Error("the terminal closed"));
    await expect(failing).rejects.toThrow("the terminal closed");

    await expect(ctx.host.resize("nope", 1, 1)).rejects.toThrow(/unknown sessionId/);
    await expect(ctx.host.write("nope", new Uint8Array())).rejects.toThrow(/unknown sessionId/);
  });
});
