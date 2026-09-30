// Shutdown drain of `RustSidecarPtyHost` against a fake sidecar child process.
//
// Covers:
//   * `DrainResult`: sessions drained in time vs forced-killed, plus `sidecarExitedCleanly` and
//     `taskkillEscalated` from the sidecar wind-down path.
//   * Per-session drain: SIGTERM, wait for the exit notification, SIGKILL after
//     `perSessionTimeoutMs`.
//   * Host wind-down: close the sidecar's stdin, wait `hostTimeoutMs` for its exit, then hard-kill
//     it (`taskkill` tree-kill on Windows, `child.kill("SIGKILL")` elsewhere).
//   * `onExit` fires once per session: no `-1` crash sentinel after a clean or forced drain, but
//     `-1` for sessions whose real exit was lost when the sidecar crashes mid-shutdown.
//   * A second `shutdown()` returns the in-flight promise; `spawn()` during or racing with
//     shutdown is rejected with `PtyBackendUnavailableError`.
//
// Lifecycle wiring is tested in `apps/desktop/src/main/services/sidecar-lifecycle.test.ts`.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { PtyBackendUnavailableError } from "../sidecar-binary-path.js";
import {
  RustSidecarPtyHost,
  type SidecarChildProcess,
  type SidecarSpawnFn,
} from "../rust-sidecar-pty-host.js";
import type { TaskkillResult } from "../taskkill-windows.js";

import type { DrainResult, Envelope } from "@ai-sidekicks/contracts";

// Fake sidecar child

interface FakeSidecarChild {
  readonly child: SidecarChildProcess;
  readStdin(): Buffer;
  /** Whether the host has closed the sidecar's stdin. */
  stdinEnded(): boolean;
  writeStdout(bytes: Buffer | string): void;
  triggerExit(code: number | null, signal: string | null): void;
  triggerError(err: Error): void;
}

function makeFakeSidecarChild(): FakeSidecarChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const ee = new EventEmitter();

  const stdinChunks: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => {
    stdinChunks.push(chunk);
  });

  let endedFlag = false;
  // Wrap stdin.end so the host's `child.stdin.end()` call is observable.
  const originalEnd = stdin.end.bind(stdin);
  stdin.end = ((...args: unknown[]) => {
    endedFlag = true;
    return originalEnd(...(args as Parameters<typeof originalEnd>));
  }) as typeof stdin.end;

  function on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): SidecarChildProcess;
  function on(event: "error", listener: (err: Error) => void): SidecarChildProcess;
  function on(
    event: "exit" | "error",
    listener: ((code: number | null, signal: string | null) => void) | ((err: Error) => void),
  ): SidecarChildProcess {
    ee.on(event, listener as (...args: unknown[]) => void);
    return child;
  }

  const child: SidecarChildProcess = {
    pid: 67890,
    stdin,
    stdout,
    stderr,
    on,
    kill: vi.fn(() => true),
  };

  return {
    child,
    readStdin: () => Buffer.concat(stdinChunks),
    stdinEnded: () => endedFlag,
    writeStdout: (bytes) => {
      stdout.write(bytes);
    },
    triggerExit: (code, signal) => {
      ee.emit("exit", code, signal);
    },
    triggerError: (err) => {
      ee.emit("error", err);
    },
  };
}

function spawnReturning(fake: FakeSidecarChild): SidecarSpawnFn {
  return vi
    .fn<SidecarSpawnFn>()
    .mockImplementation(() => fake.child as unknown as ReturnType<SidecarSpawnFn>);
}

function frameEnvelope(envelope: Envelope): Buffer {
  const payload: Buffer = Buffer.from(JSON.stringify(envelope), "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

function parseFramesFromStdin(stdinBuf: Buffer): Envelope[] {
  const envelopes: Envelope[] = [];
  let cursor = 0;
  while (cursor < stdinBuf.length) {
    const headerEnd: number = stdinBuf.indexOf("\r\n\r\n", cursor);
    if (headerEnd === -1) {
      break;
    }
    const headerBytes: Buffer = stdinBuf.subarray(cursor, headerEnd);
    const headerText: string = headerBytes.toString("utf8");
    const match: RegExpMatchArray | null = headerText.match(/Content-Length:\s*(\d+)/i);
    if (match === null) {
      break;
    }
    const length: number = Number.parseInt(match[1] ?? "0", 10);
    const bodyStart: number = headerEnd + 4;
    const body: Buffer = stdinBuf.subarray(bodyStart, bodyStart + length);
    envelopes.push(JSON.parse(body.toString("utf8")) as Envelope);
    cursor = bodyStart + length;
  }
  return envelopes;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Spawns one session and resolves its `SpawnResponse` through the fake. */
async function spawnOneSession(
  host: RustSidecarPtyHost,
  fake: FakeSidecarChild,
  sessionId: string,
): Promise<void> {
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
  fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: sessionId }));
  await spawnPromise;
}

describe("RustSidecarPtyHost.shutdown — polymorphic drain", () => {
  it("with no spawned sessions returns vacuous DrainResult (0/0, host clean)", async () => {
    const fake = makeFakeSidecarChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // No child was ever spawned, so the host wind-down is skipped.
    const result: DrainResult = await host.shutdown({
      perSessionTimeoutMs: 100,
      hostTimeoutMs: 100,
    });

    expect(result).toEqual({
      sessionsDrained: 0,
      sessionsForcedKilled: 0,
      sidecarExitedCleanly: true,
      taskkillEscalated: false,
    });
  });

  it("counts a session that emits ExitCodeNotification within the per-session budget under sessionsDrained", async () => {
    const fake = makeFakeSidecarChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });
    const onExit = vi.fn();
    host.setOnExit(onExit);

    await spawnOneSession(host, fake, "s-0");

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
  });

  it("counts a session that exceeds the per-session timeout under sessionsForcedKilled and dispatches kill_request{SIGKILL}", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeSidecarChild();
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
      });

      await spawnOneSession(host, fake, "s-0");

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
  });

  it("closes sidecar stdin and reports sidecarExitedCleanly:true when the child exits within the host timeout", async () => {
    const fake = makeFakeSidecarChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    await spawnOneSession(host, fake, "s-0");

    const drainPromise = host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });
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
    await flushMicrotasks();
    await flushMicrotasks();

    // Stdin is closed once the per-session drains finish.
    expect(fake.stdinEnded()).toBe(true);

    fake.triggerExit(0, null);
    await flushMicrotasks();

    const result = await drainPromise;
    expect(result.sidecarExitedCleanly).toBe(true);
    expect(result.taskkillEscalated).toBe(false);
  });

  it("escalates via child.kill('SIGKILL') and reports taskkillEscalated:true when the sidecar does not exit within hostTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeSidecarChild();
      // Pin the platform so the POSIX `child.kill("SIGKILL")` escalation runs on any CI runner.
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
        platform: "linux",
      });

      await spawnOneSession(host, fake, "s-0");

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
  });

  it("escalates via spawnTaskkill (Windows tree-kill) and reports taskkillEscalated:true when the sidecar does not exit within hostTimeoutMs", async () => {
    // On Windows a wedged sidecar is tree-killed with `taskkill /T /F /PID`: Node's SIGKILL ends
    // only that one process and would leave its PTY workers orphaned.
    vi.useFakeTimers();
    try {
      const fake = makeFakeSidecarChild();
      const mockTaskkill: ReturnType<typeof vi.fn<(pid: number) => Promise<TaskkillResult>>> = vi
        .fn<(pid: number) => Promise<TaskkillResult>>()
        .mockResolvedValue({ exitCode: 0 });
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
        platform: "win32",
        spawnTaskkill: mockTaskkill,
      });

      await spawnOneSession(host, fake, "s-0");

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

      // The escalation returns once `spawnTaskkill` resolves; the child's own exit may come later.
      fake.triggerExit(0, null);
      await Promise.resolve();
      await Promise.resolve();

      const result = await drainPromise;
      expect(result.sidecarExitedCleanly).toBe(false);
      expect(result.taskkillEscalated).toBe(true);

      // The tree-kill targets the sidecar pid (67890, from `makeFakeSidecarChild`).
      expect(mockTaskkill).toHaveBeenCalledTimes(1);
      expect(mockTaskkill).toHaveBeenCalledWith(67890);

      // The single-PID SIGKILL fallback is not used on Windows.
      expect(fake.child.kill).not.toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the Windows tree-kill escalation by 5 s wall-clock when spawnTaskkill never settles", async () => {
    // Even if `taskkill.exe` never returns, `escalateHardKillTree` gives up after 5 s and the
    // drain resolves. Without that bound this test would hang past vitest's 5 s test timeout.
    vi.useFakeTimers();
    try {
      const fake = makeFakeSidecarChild();
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

      await spawnOneSession(host, fake, "s-0");

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
      expect(neverSettlingTaskkill).toHaveBeenCalledWith(67890);

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
  });

  it("suppresses the -1 crash sentinel AND fires synthetic onExit(code=1) on the deliberate sidecar exit when the per-session timeout escalates to SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeSidecarChild();
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
      });
      const onExit = vi.fn();
      host.setOnExit(onExit);

      await spawnOneSession(host, fake, "s-0");

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
  });

  it("emits -1 onExit for sessions whose real ExitCodeNotification never arrived when sidecar crashes mid-shutdown", async () => {
    // If the sidecar crashes mid-shutdown before every session's real exit notification arrived,
    // `fireCrashTimeOnExit` sends the `-1` sentinel to the sessions whose exit was lost, so
    // `onExit` fires exactly once per session. Sessions that already have an exit code are skipped.
    // s-A gets its real exit and is skipped. s-B gets `-1` and is removed from the host; its drain
    // then times out into SIGKILL (the synthetic finds no record and does nothing), so it counts as
    // forced-killed.

    vi.useFakeTimers();
    try {
      const fake = makeFakeSidecarChild();
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
      });
      const onExit = vi.fn();
      host.setOnExit(onExit);

      await spawnOneSession(host, fake, "s-A");
      await spawnOneSession(host, fake, "s-B");

      const drainPromise = host.shutdown({
        perSessionTimeoutMs: 1_000,
        hostTimeoutMs: 1_000,
      });
      await Promise.resolve();
      await Promise.resolve();

      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-A" }));
      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-B" }));
      // Only s-A's real exit arrives before the crash.
      fake.writeStdout(
        frameEnvelope({
          kind: "exit_code_notification",
          session_id: "s-A",
          exit_code: 0,
          signal_code: null,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      // The crash skips s-A (exit code already set) and sends s-B the `-1` sentinel.
      fake.triggerExit(null, "SIGSEGV");
      await Promise.resolve();
      await Promise.resolve();

      // Nothing releases s-B's drain waiter, so its drain falls through the per-session timeout to
      // SIGKILL and returns "forced".
      await vi.advanceTimersByTimeAsync(1_001);
      await Promise.resolve();
      await Promise.resolve();

      const result = await drainPromise;

      // s-A got exactly one `onExit` with its real exit code, not `-1`.
      const aCalls = onExit.mock.calls.filter((call) => call[0] === "s-A");
      expect(aCalls).toHaveLength(1);
      expect(aCalls[0]).toEqual(["s-A", 0]);

      // s-B got exactly one `onExit`, with `-1`.
      const bCalls = onExit.mock.calls.filter((call) => call[0] === "s-B");
      expect(bCalls).toHaveLength(1);
      expect(bCalls[0]).toEqual(["s-B", -1]);

      // One `onExit` per session, none doubled.
      expect(onExit).toHaveBeenCalledTimes(2);

      // Both sessions are gone from the host: `kill()` rejects for an unknown id.
      await expect(host.kill("s-A", "SIGTERM")).rejects.toThrow(/unknown sessionId/);
      await expect(host.kill("s-B", "SIGTERM")).rejects.toThrow(/unknown sessionId/);

      // s-B was forced (its waiter never resolved); s-A drained in time.
      expect(result.sessionsDrained).toBe(1);
      expect(result.sessionsForcedKilled).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forced-kills a session when sidecar IPC is wedged and kill_response never arrives within perSessionTimeoutMs", async () => {
    // A wedged sidecar (alive but never answering `kill_request`) must not stall the drain, so the
    // per-session timer is armed before the SIGTERM request is awaited. Otherwise the drain, and
    // every later `shutdown()` call sharing its promise, would hang forever. The test drops the
    // reply entirely (a merely late reply would hide the bug) and never fires the child's exit.
    vi.useFakeTimers();
    try {
      const fake = makeFakeSidecarChild();
      // Pin the platform so the POSIX `child.kill("SIGKILL")` escalation runs on any CI runner.
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
        platform: "linux",
      });
      const onExit = vi.fn();
      host.setOnExit(onExit);

      await spawnOneSession(host, fake, "s-0");

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
  });

  it("forces a session when sidecar crashes mid-shutdown after SIGTERM IPC rejects via rejectAllOutstanding", async () => {
    // The sidecar crashes before acking SIGTERM. `fireCrashTimeOnExit` fires the `-1` sentinel and
    // removes the session, and `rejectAllOutstanding` rejects the pending SIGTERM request. No exit
    // notification can arrive and the crash path does not release the drain waiter, so the
    // per-session timer forces the session; the SIGKILL synthetic finds no record and stays silent.
    // The consumer sees exactly one `onExit(s-0, -1)`.
    vi.useFakeTimers();
    try {
      const fake = makeFakeSidecarChild();
      const host = new RustSidecarPtyHost({
        resolveBinaryPath: () => "/fake/sidecar",
        spawn: spawnReturning(fake),
      });
      const onExit = vi.fn();
      host.setOnExit(onExit);

      await spawnOneSession(host, fake, "s-0");

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
  });

  it("rejects concurrent spawn() during shutdown with PtyBackendUnavailableError", async () => {
    const fake = makeFakeSidecarChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    await spawnOneSession(host, fake, "s-0");

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

  it("rejects an in-flight spawn() whose SpawnResponse arrives AFTER shutdown() flips the shuttingDown flag (pre-spawn race)", async () => {
    // A `spawn()` already awaiting its `SpawnResponse` when `shutdown()` starts: shutdown snapshots
    // no sessions, then the response arrives. `resolveOutstanding` must reject the spawn with
    // `PtyBackendUnavailableError` rather than register a session that shutdown has left behind.

    const fake = makeFakeSidecarChild();
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
  });

  it("is idempotent and re-entrant — a second shutdown() call returns the same in-flight Promise", async () => {
    const fake = makeFakeSidecarChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    await spawnOneSession(host, fake, "s-0");

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
  });

  it("resets childExitedBeforeDrain in attachChildListeners so a respawned child does not inherit the prior crashed child's flag (stale-event safety)", async () => {
    // `childExitedBeforeDrain` is reset when a fresh child is attached, so a respawned sidecar
    // that drains cleanly reports `sidecarExitedCleanly: true` instead of inheriting the flag left
    // by the crashed one. The private flag is not read directly: the test crashes child A, respawns
    // as child B and drains B.

    // The first `spawnFn` call returns child A; the call after A crashed returns child B.
    const fakeA = makeFakeSidecarChild();
    const fakeB = makeFakeSidecarChild();
    let spawnCount = 0;
    const spawnFn: SidecarSpawnFn = vi.fn<SidecarSpawnFn>().mockImplementation(() => {
      spawnCount += 1;
      return (spawnCount === 1
        ? fakeA.child
        : fakeB.child) as unknown as ReturnType<SidecarSpawnFn>;
    });

    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnFn,
    });
    const onExit = vi.fn();
    host.setOnExit(onExit);

    // Spawn s-A on child A, then crash A.
    await spawnOneSession(host, fakeA, "s-A");
    fakeA.triggerExit(null, "SIGSEGV");
    await flushMicrotasks();
    await flushMicrotasks();

    // Spawning s-B cold-starts child B.
    await spawnOneSession(host, fakeB, "s-B");

    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Drain s-B: it exits with a real notification, then the sidecar exits on stdin EOF.
    const drainPromise = host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });
    await flushMicrotasks();
    fakeB.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-B" }));
    fakeB.writeStdout(
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-B",
        exit_code: 0,
        signal_code: null,
      }),
    );
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // Stdin is closed, so the drain is parked on child B's exit.
    expect(fakeB.stdinEnded()).toBe(true);

    fakeB.triggerExit(0, null);
    await flushMicrotasks();

    const result = await drainPromise;

    // Child B never exited mid-drain, so the drain is clean.
    expect(result.sidecarExitedCleanly).toBe(true);
    expect(result.taskkillEscalated).toBe(false);

    // s-B drained in time.
    expect(result.sessionsDrained).toBe(1);
    expect(result.sessionsForcedKilled).toBe(0);
  });
});
