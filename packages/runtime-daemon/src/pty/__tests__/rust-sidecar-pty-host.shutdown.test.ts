// `RustSidecarPtyHost.shutdown` against a fake sidecar child: each session is drained (SIGTERM,
// then SIGKILL after `perSessionTimeoutMs`), then the sidecar is closed and hard-killed after
// `hostTimeoutMs`, so no PTY process outlives the daemon.

import { describe, expect, it, vi } from "vitest";

import { PtyBackendUnavailableError } from "../sidecar-binary-path.js";
import { RustSidecarPtyHost } from "../rust-sidecar-pty-host.js";
import type { TaskkillResult } from "../taskkill-windows.js";
import {
  flushMicrotasks,
  frameEnvelope,
  makeFakeSidecarChild,
  parseFramesFromStdin,
  spawnAnsweredSession,
  spawnReturning,
} from "./pty-host.test-support.js";

// Distinctive, so a taskkill assertion names the sidecar's pid.
const SIDECAR_PID = 67890;

describe("RustSidecarPtyHost.shutdown — drain", () => {
  it(
    "counts a session that emits ExitCodeNotification within the per-session budget under " +
      "sessionsDrained",
    async () => {
      const fake = makeFakeSidecarChild(SIDECAR_PID);
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
      });
      const onExit = vi.fn();
      host.setOnExit(onExit);

      await spawnAnsweredSession(host, () => fake, "s-0");

      const drainPromise = host.shutdown({
        perSessionTimeoutMs: 2_000,
        hostTimeoutMs: 2_000,
      });
      // Let the SIGTERM `kill_request` reach the wire.
      await flushMicrotasks();

      const framesAfterTerm = parseFramesFromStdin(fake.readStdin());
      const lastFrame = framesAfterTerm[framesAfterTerm.length - 1];
      expect(lastFrame).toMatchObject({
        kind: "kill_request",
        session_id: "s-0",
        signal: "SIGTERM",
      });

      // The exit notification fires `onExit` and releases the per-session drain waiter.
      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
      fake.writeStdout(
        frameEnvelope({
          kind: "exit_code_notification",
          session_id: "s-0",
          exit_code: 0,
          signal_code: null,
        }),
      );
      // Let the per-session drain settle so `drainSidecarHost` closes stdin and parks on the host
      // exit waiter. An exit racing ahead of that would take the child-already-gone path and report
      // `sidecarExitedCleanly: false`, so the `stdinEnded()` check below pins the timing.
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      // Stdin is closed, so the exit below counts as a clean wind-down.
      expect(fake.stdinEnded()).toBe(true);

      fake.triggerExit(0, null);
      await flushMicrotasks();

      const result = await drainPromise;
      expect(result.sessionsDrained).toBe(1);
      expect(result.sessionsForcedKilled).toBe(0);
      expect(result.sidecarExitedCleanly).toBe(true);
      expect(result.taskkillEscalated).toBe(false);

      // The real notification fired `onExit` once; the `-1` crash sentinel did not.
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith("s-0", 0);
    },
  );

  it(
    "counts a session that exceeds the per-session timeout under sessionsForcedKilled and " +
      "dispatches kill_request{SIGKILL}",
    async () => {
      vi.useFakeTimers();
      try {
        const fake = makeFakeSidecarChild(SIDECAR_PID);
        const host = new RustSidecarPtyHost({
          resolveBinaryPath: () => "/fake/sidecar",
          spawn: spawnReturning(fake),
        });

        await spawnAnsweredSession(host, () => fake, "s-0");

        const drainPromise = host.shutdown({
          perSessionTimeoutMs: 2_000,
          hostTimeoutMs: 2_000,
        });
        await Promise.resolve();
        await Promise.resolve();
        // Ack SIGTERM without an exit notification: the child ignores SIGTERM.
        fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
        await Promise.resolve();
        await Promise.resolve();

        // Past the per-session timeout the drain escalates to SIGKILL.
        await vi.advanceTimersByTimeAsync(2_001);
        fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
        // The late exit notification lets teardown finish.
        fake.writeStdout(
          frameEnvelope({
            kind: "exit_code_notification",
            session_id: "s-0",
            exit_code: 137,
            signal_code: 9,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();

        fake.triggerExit(0, null);
        await Promise.resolve();
        await Promise.resolve();

        const result = await drainPromise;
        expect(result.sessionsDrained).toBe(0);
        expect(result.sessionsForcedKilled).toBe(1);

        const frames = parseFramesFromStdin(fake.readStdin());
        const killFrames = frames.filter(
          (
            envelope,
          ): envelope is {
            kind: "kill_request";
            session_id: string;
            signal: "SIGTERM" | "SIGKILL";
          } => envelope.kind === "kill_request",
        );
        expect(killFrames).toHaveLength(2);
        expect(killFrames[0]?.signal).toBe("SIGTERM");
        expect(killFrames[1]?.signal).toBe("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "escalates via child.kill('SIGKILL') and reports taskkillEscalated:true when the sidecar " +
      "does not exit within hostTimeoutMs",
    async () => {
      vi.useFakeTimers();
      try {
        const fake = makeFakeSidecarChild(SIDECAR_PID);
        // Pin the platform so the POSIX `child.kill("SIGKILL")` escalation runs on any CI runner.
        const host = new RustSidecarPtyHost({
          resolveBinaryPath: () => "/fake/sidecar",
          spawn: spawnReturning(fake),
          platform: "linux",
        });

        await spawnAnsweredSession(host, () => fake, "s-0");

        const drainPromise = host.shutdown({
          perSessionTimeoutMs: 2_000,
          hostTimeoutMs: 2_000,
        });
        await Promise.resolve();
        await Promise.resolve();
        fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
        fake.writeStdout(
          frameEnvelope({
            kind: "exit_code_notification",
            session_id: "s-0",
            exit_code: 0,
            signal_code: null,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();

        // The sidecar ignores stdin EOF; advance past the host timeout.
        await vi.advanceTimersByTimeAsync(2_001);
        await Promise.resolve();
        await Promise.resolve();

        fake.triggerExit(0, null);
        await Promise.resolve();
        await Promise.resolve();

        const result = await drainPromise;
        expect(result.sidecarExitedCleanly).toBe(false);
        expect(result.taskkillEscalated).toBe(true);

        expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "escalates via spawnTaskkill (Windows tree-kill) and reports taskkillEscalated:true when " +
      "the sidecar does not exit within hostTimeoutMs",
    async () => {
      // On Windows a wedged sidecar is tree-killed with `taskkill /T /F /PID`: Node's SIGKILL ends
      // only that one process and would leave its PTY workers orphaned.
      vi.useFakeTimers();
      try {
        const fake = makeFakeSidecarChild(SIDECAR_PID);
        const mockTaskkill: ReturnType<typeof vi.fn<(pid: number) => Promise<TaskkillResult>>> = vi
          .fn<(pid: number) => Promise<TaskkillResult>>()
          .mockResolvedValue({ exitCode: 0 });
        const host = new RustSidecarPtyHost({
          resolveBinaryPath: () => "/fake/sidecar",
          spawn: spawnReturning(fake),
          platform: "win32",
          spawnTaskkill: mockTaskkill,
        });

        await spawnAnsweredSession(host, () => fake, "s-0");

        const drainPromise = host.shutdown({
          perSessionTimeoutMs: 2_000,
          hostTimeoutMs: 2_000,
        });
        await Promise.resolve();
        await Promise.resolve();
        // Per-session drain succeeds; only the host-level stdin EOF is ignored.
        fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
        fake.writeStdout(
          frameEnvelope({
            kind: "exit_code_notification",
            session_id: "s-0",
            exit_code: 0,
            signal_code: null,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();

        // Advance past the host timeout so the drain escalates.
        await vi.advanceTimersByTimeAsync(2_001);
        await Promise.resolve();
        await Promise.resolve();

        // The escalation returns once `spawnTaskkill` resolves; the child's own exit may come
        // later.
        fake.triggerExit(0, null);
        await Promise.resolve();
        await Promise.resolve();

        const result = await drainPromise;
        expect(result.sidecarExitedCleanly).toBe(false);
        expect(result.taskkillEscalated).toBe(true);

        // The tree-kill targets the sidecar pid.
        expect(mockTaskkill).toHaveBeenCalledTimes(1);
        expect(mockTaskkill).toHaveBeenCalledWith(SIDECAR_PID);

        // The single-PID SIGKILL fallback is not used on Windows.
        expect(fake.child.kill).not.toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "bounds the Windows tree-kill escalation by 5 " +
      "s wall-clock when spawnTaskkill never settles",
    async () => {
      // Even if `taskkill.exe` never returns, `escalateHardKillTree` gives up after 5 s and the
      // drain resolves. Without that bound this test would hang past vitest's 5 s test timeout.
      vi.useFakeTimers();
      try {
        const fake = makeFakeSidecarChild(SIDECAR_PID);
        // A `spawnTaskkill` that never settles stands in for a stuck `taskkill.exe`.
        const neverSettlingTaskkill: ReturnType<
          typeof vi.fn<(pid: number) => Promise<TaskkillResult>>
        > = vi
          .fn<(pid: number) => Promise<TaskkillResult>>()
          .mockImplementation(() => new Promise<TaskkillResult>(() => {}));
        const host = new RustSidecarPtyHost({
          resolveBinaryPath: () => "/fake/sidecar",
          spawn: spawnReturning(fake),
          platform: "win32",
          spawnTaskkill: neverSettlingTaskkill,
        });

        await spawnAnsweredSession(host, () => fake, "s-0");

        const drainPromise = host.shutdown({
          perSessionTimeoutMs: 2_000,
          hostTimeoutMs: 2_000,
        });
        await Promise.resolve();
        await Promise.resolve();
        fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
        fake.writeStdout(
          frameEnvelope({
            kind: "exit_code_notification",
            session_id: "s-0",
            exit_code: 0,
            signal_code: null,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();

        // Past the host timeout the drain escalates and starts the 5 s taskkill bound.
        await vi.advanceTimersByTimeAsync(2_001);
        await Promise.resolve();
        await Promise.resolve();

        // `spawnTaskkill` was called and never settles; only the 5 s bound can end the drain.
        expect(neverSettlingTaskkill).toHaveBeenCalledTimes(1);
        expect(neverSettlingTaskkill).toHaveBeenCalledWith(SIDECAR_PID);

        // Past the 5 s bound the escalation returns and the drain reports `taskkillEscalated`.
        await vi.advanceTimersByTimeAsync(5_001);
        await Promise.resolve();
        await Promise.resolve();

        const result = await drainPromise;
        expect(result.sidecarExitedCleanly).toBe(false);
        expect(result.taskkillEscalated).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "suppresses the -1 crash sentinel AND fires synthetic onExit(code=1) on the deliberate " +
      "sidecar exit when the per-session timeout escalates to SIGKILL",
    async () => {
      vi.useFakeTimers();
      try {
        const fake = makeFakeSidecarChild(SIDECAR_PID);
        const host = new RustSidecarPtyHost({
          resolveBinaryPath: () => "/fake/sidecar",
          spawn: spawnReturning(fake),
        });
        const onExit = vi.fn();
        host.setOnExit(onExit);

        await spawnAnsweredSession(host, () => fake, "s-0");

        const drainPromise = host.shutdown({
          perSessionTimeoutMs: 2_000,
          hostTimeoutMs: 2_000,
        });
        await Promise.resolve();
        await Promise.resolve();
        // Ack SIGTERM without an exit notification, as if the child exited before it was reported.
        fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
        await Promise.resolve();
        await Promise.resolve();

        // Past the per-session timeout the drain escalates to SIGKILL.
        await vi.advanceTimersByTimeAsync(2_001);
        fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
        await Promise.resolve();
        await Promise.resolve();

        // The sidecar exits: `fireCrashTimeOnExit` skips s-0 because the SIGKILL synthetic already
        // set its exit code, so no `-1` fires.
        fake.triggerExit(0, null);
        await Promise.resolve();
        await Promise.resolve();

        await drainPromise;

        // A forced kill still fires `onExit` once, as `(sessionId, 1)` with no signal code, as
        // `NodePtyHost` does when it escalates to taskkill. `-1` is reserved for a sidecar crash.
        expect(onExit).toHaveBeenCalledTimes(1);
        expect(onExit).toHaveBeenCalledWith("s-0", 1);
        const negOneCalls = onExit.mock.calls.filter((call) => call[1] === -1);
        expect(negOneCalls).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "forced-kills a session when sidecar IPC is wedged and kill_response never arrives within " +
      "perSessionTimeoutMs",
    async () => {
      // A wedged sidecar (alive but never answering `kill_request`) must not stall the drain, so
      // the per-session timer is armed before the SIGTERM request is awaited. Otherwise the drain,
      // and every later `shutdown()` call sharing its promise, would hang forever. The test drops
      // the reply entirely (a merely late reply would hide the bug) and never fires the child's
      // exit.
      vi.useFakeTimers();
      try {
        const fake = makeFakeSidecarChild(SIDECAR_PID);
        // Pin the platform so the POSIX `child.kill("SIGKILL")` escalation runs on any CI runner.
        const host = new RustSidecarPtyHost({
          resolveBinaryPath: () => "/fake/sidecar",
          spawn: spawnReturning(fake),
          platform: "linux",
        });
        const onExit = vi.fn();
        host.setOnExit(onExit);

        await spawnAnsweredSession(host, () => fake, "s-0");

        const drainPromise = host.shutdown({
          perSessionTimeoutMs: 50,
          hostTimeoutMs: 500,
        });
        await Promise.resolve();
        await Promise.resolve();

        // SIGTERM was sent; its reply never comes.
        const framesAfterTerm = parseFramesFromStdin(fake.readStdin());
        const termFrames = framesAfterTerm.filter(
          (
            envelope,
          ): envelope is {
            kind: "kill_request";
            session_id: string;
            signal: "SIGTERM" | "SIGKILL";
          } => envelope.kind === "kill_request",
        );
        expect(termFrames).toHaveLength(1);
        expect(termFrames[0]?.signal).toBe("SIGTERM");

        // The per-session timer has not fired yet, so there is no synthetic `onExit`.
        expect(onExit).not.toHaveBeenCalled();

        // Past the per-session timeout the drain stops waiting and forces the session.
        await vi.advanceTimersByTimeAsync(51);

        // The forced kill fired `onExit` once, as `(sessionId, 1)` with no signal code.
        expect(onExit).toHaveBeenCalledTimes(1);
        expect(onExit).toHaveBeenCalledWith("s-0", 1);

        // SIGKILL is sent without waiting for a reply; none is ever queued.
        const framesAfterKill = parseFramesFromStdin(fake.readStdin());
        const killFrames = framesAfterKill.filter(
          (
            envelope,
          ): envelope is {
            kind: "kill_request";
            session_id: string;
            signal: "SIGTERM" | "SIGKILL";
          } => envelope.kind === "kill_request",
        );
        expect(killFrames).toHaveLength(2);
        expect(killFrames[1]?.signal).toBe("SIGKILL");

        // The sidecar ignores stdin EOF too; advance past the host timeout so it is hard-killed.
        await vi.advanceTimersByTimeAsync(501);
        await Promise.resolve();
        await Promise.resolve();

        const result = await drainPromise;

        // The IPC never acked and no exit arrived, so the session counts as forced-killed.
        expect(result.sessionsDrained).toBe(0);
        expect(result.sessionsForcedKilled).toBe(1);

        // The host wind-down escalated too, ending in `child.kill("SIGKILL")`.
        expect(result.sidecarExitedCleanly).toBe(false);
        expect(result.taskkillEscalated).toBe(true);
        expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "forces a session when sidecar crashes mid-shutdown after SIGTERM IPC rejects via " +
      "rejectAllOutstanding",
    async () => {
      // The sidecar crashes before acking SIGTERM. `fireCrashTimeOnExit` fires the `-1` sentinel
      // and removes the session, and `rejectAllOutstanding` rejects the pending SIGTERM request. No
      // exit notification can arrive and the crash path does not release the drain waiter, so the
      // per-session timer forces the session; the SIGKILL synthetic finds no record and stays
      // silent. The consumer sees exactly one `onExit(s-0, -1)`.
      vi.useFakeTimers();
      try {
        const fake = makeFakeSidecarChild(SIDECAR_PID);
        const host = new RustSidecarPtyHost({
          resolveBinaryPath: () => "/fake/sidecar",
          spawn: spawnReturning(fake),
        });
        const onExit = vi.fn();
        host.setOnExit(onExit);

        await spawnAnsweredSession(host, () => fake, "s-0");

        const drainPromise = host.shutdown({
          perSessionTimeoutMs: 50,
          hostTimeoutMs: 500,
        });
        await Promise.resolve();
        await Promise.resolve();

        // Crash before the SIGTERM ack.
        fake.triggerExit(null, "SIGSEGV");
        await Promise.resolve();
        await Promise.resolve();

        // The `-1` sentinel already fired; the per-session timer is still pending.
        expect(onExit).toHaveBeenCalledTimes(1);
        expect(onExit).toHaveBeenCalledWith("s-0", -1);

        // The timer expires and the drain forces the session.
        await vi.advanceTimersByTimeAsync(51);
        await Promise.resolve();
        await Promise.resolve();

        const result = await drainPromise;

        // The session counts as forced-killed.
        expect(result.sessionsDrained).toBe(0);
        expect(result.sessionsForcedKilled).toBe(1);

        // The `-1` sentinel is the only `onExit`: the SIGKILL synthetic found no record.
        expect(onExit).toHaveBeenCalledTimes(1);
        const calls = onExit.mock.calls;
        expect(calls[0]).toEqual(["s-0", -1]);

        // A child that crashed before the host drain reports `sidecarExitedCleanly: false`, so
        // telemetry shows the crash. No taskkill was needed, so `taskkillEscalated` stays false.
        expect(result.sidecarExitedCleanly).toBe(false);
        expect(result.taskkillEscalated).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rejects concurrent spawn() during shutdown with PtyBackendUnavailableError", async () => {
    const fake = makeFakeSidecarChild(SIDECAR_PID);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    await spawnAnsweredSession(host, () => fake, "s-0");

    const drainPromise = host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });
    await flushMicrotasks();

    // A `spawn()` after shutdown starts must be rejected: the host is terminal.
    await expect(
      host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      }),
    ).rejects.toBeInstanceOf(PtyBackendUnavailableError);

    // Finish the drain so the test cleans up.
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    fake.writeStdout(
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
    );
    await flushMicrotasks();
    fake.triggerExit(0, null);
    await drainPromise;
  });

  it(
    "rejects an in-flight spawn() whose SpawnResponse arrives AFTER shutdown() flips the " +
      "shuttingDown flag (pre-spawn race)",
    async () => {
      // A `spawn()` already awaiting its `SpawnResponse` when `shutdown()` starts: shutdown
      // snapshots no sessions, then the response arrives. `resolveOutstanding` must reject the
      // spawn with `PtyBackendUnavailableError` rather than register a session that shutdown has
      // left behind.

      const fake = makeFakeSidecarChild(SIDECAR_PID);
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
      });

      // Start `spawn()` without awaiting so the race can be driven step by step.
      const spawnPromise = host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: ["-c", "sleep 10"],
        env: [],
        cwd: "/tmp",
        rows: 24,
        cols: 80,
      });

      await flushMicrotasks();
      await flushMicrotasks();

      // The SpawnRequest is on the wire, so `ensureChild` ran before shutdown.
      const framesBeforeShutdown = parseFramesFromStdin(fake.readStdin());
      expect(framesBeforeShutdown.some((envelope) => envelope.kind === "spawn_request")).toBe(true);

      // `shutdown()` snapshots no sessions because the spawn has not registered one yet.
      const drainPromise = host.shutdown({
        perSessionTimeoutMs: 2_000,
        hostTimeoutMs: 2_000,
      });
      await flushMicrotasks();

      // The response arrives after the flag flipped; the guard must reject it, not register it.
      fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-orphan" }));
      await flushMicrotasks();

      await expect(spawnPromise).rejects.toBeInstanceOf(PtyBackendUnavailableError);

      // The would-be session was never registered: `kill()` rejects with "unknown sessionId".
      await expect(host.kill("s-orphan", "SIGTERM")).rejects.toThrow(/unknown sessionId/);

      // Let the sidecar exit to finish the drain.
      fake.triggerExit(0, null);
      await flushMicrotasks();

      const result = await drainPromise;
      expect(result.sessionsDrained).toBe(0);
      expect(result.sessionsForcedKilled).toBe(0);
      expect(result.sidecarExitedCleanly).toBe(true);
      expect(result.taskkillEscalated).toBe(false);
    },
  );

  it(
    "is idempotent and re-entrant — a second " +
      "shutdown() call returns the same in-flight Promise",
    async () => {
      const fake = makeFakeSidecarChild(SIDECAR_PID);
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
      });

      await spawnAnsweredSession(host, () => fake, "s-0");

      const firstPromise = host.shutdown({
        perSessionTimeoutMs: 2_000,
        hostTimeoutMs: 2_000,
      });
      const secondPromise = host.shutdown({
        perSessionTimeoutMs: 2_000,
        hostTimeoutMs: 2_000,
      });

      expect(secondPromise).toBe(firstPromise);

      await flushMicrotasks();
      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
      fake.writeStdout(
        frameEnvelope({
          kind: "exit_code_notification",
          session_id: "s-0",
          exit_code: 0,
          signal_code: null,
        }),
      );
      await flushMicrotasks();
      fake.triggerExit(0, null);

      const result = await firstPromise;
      const secondResult = await secondPromise;
      expect(secondResult).toBe(result);
    },
  );
});
