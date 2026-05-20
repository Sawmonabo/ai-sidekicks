// RustSidecarPtyHost shutdown drain tests — Plan-001 §CP-001-1 polymorphic axis.
//
// What this asserts:
//
//   * Contract surface (`PtyHost.shutdown` per
//     `packages/contracts/src/pty-host.ts`): `shutdown()` returns a
//     `DrainResult` with the four-value summary. Out-of-process backend
//     reports real values for `sidecarExitedCleanly` +
//     `taskkillEscalated` based on the sidecar wind-down path.
//   * Per-session graceful drain: a session whose
//     `ExitCodeNotification` arrives within `perSessionTimeoutMs` of
//     the SIGTERM dispatch counts under `sessionsDrained`.
//   * Per-session forced kill: a session that does NOT exit before
//     the timeout fires escalates via `kill_request{SIGKILL}` and
//     counts under `sessionsForcedKilled`.
//   * Sidecar host wind-down: after per-session drains, `shutdown()`
//     closes the sidecar's stdin and waits for the child's `exit`
//     event up to `hostTimeoutMs`. Clean exit → `sidecarExitedCleanly:
//     true`. Timeout → `taskkillEscalated: true`.
//   * Crash-budget suppression: the deliberate sidecar exit during
//     `shutdown()` does NOT consume a slot of the sliding-window
//     crash budget — Plan-001 §CP-001-1 hard constraint.
//   * No spurious `-1` crash sentinel on clean wind-down: a
//     deliberate sidecar exit AFTER real `ExitCodeNotification`s have
//     been routed does NOT fire the per-session `-1` synthetic
//     onExit (natural dedupe via `record.exitCode !== null`).
//   * Fallback `-1` crash sentinel on shutdown × sidecar-crash: when
//     the sidecar crashes mid-shutdown and some sessions' real
//     `ExitCodeNotification`s were lost, `fireCrashTimeOnExit` MUST
//     emit the `-1` synthetic for the lost sessions — exactly-once
//     `onExit` contract on `PtyHost`.
//   * Re-entrancy: a second `shutdown()` call returns the same Promise
//     identity as the in-flight first call.
//   * Concurrent spawn() during shutdown: rejected with
//     `PtyBackendUnavailableError` — the host is terminal post-shutdown
//     entry.
//
// Refs:
//   • Plan-001 §Cross-Plan Obligations CP-001-1 — drain orchestration.
//   • Plan-024 §Invariants I-024-4 — primary FIFO + drain invariant
//     (this test exercises the drain portion; lifecycle wiring tests
//     live in `apps/desktop/test/sidecar-lifecycle.test.ts`).
//   • ADR-019 §Decision item 8 — backend polymorphism.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  PtyBackendUnavailableError,
  RustSidecarPtyHost,
  type SidecarChildProcess,
  type SidecarSpawnFn,
} from "../rust-sidecar-pty-host.js";

import type { DrainResult, Envelope } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Fake child — minimal shape mirroring `SidecarChildProcess`
// ----------------------------------------------------------------------------

interface FakeSidecarChild {
  readonly child: SidecarChildProcess;
  readStdin(): Buffer;
  /**
   * Snapshot of bytes written to stdin BEFORE `stdin.end()` was
   * called — exposed separately so the test can assert what the host
   * wrote before signaling EOF.
   */
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
    // Cast to `never` because PassThrough.end has overloads we don't
    // need to enumerate for the test stub.
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

/**
 * Spawn one session against the supervisor and resolve its
 * `SpawnResponse` via the fake — the standard fixture for the shutdown
 * scenarios below.
 */
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

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost.shutdown — Plan-001 CP-001-1 polymorphic drain", () => {
  it("with no spawned sessions returns vacuous DrainResult (0/0, host clean)", async () => {
    const fake = makeFakeSidecarChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // No sessions, no sidecar ever spawned — the host returns
    // immediately because `this.child === null` short-circuits the
    // host wind-down.
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
    // Yield so `sendRequest(kill_request{SIGTERM})` reaches the wire.
    await flushMicrotasks();

    // Verify the supervisor dispatched a kill_request{SIGTERM} for
    // the session.
    const framesAfterTerm = parseFramesFromStdin(fake.readStdin());
    const lastFrame = framesAfterTerm[framesAfterTerm.length - 1];
    expect(lastFrame).toMatchObject({
      kind: "kill_request",
      session_id: "s-0",
      signal: "SIGTERM",
    });

    // Sidecar responds with kill_response (best-effort ack), then
    // emits ExitCodeNotification — the supervisor fires onExit AND
    // ticks the per-session drain waiter.
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

    // Trigger sidecar exit so the host wind-down can complete.
    fake.triggerExit(0, null);
    await flushMicrotasks();

    const result = await drainPromise;
    expect(result.sessionsDrained).toBe(1);
    expect(result.sessionsForcedKilled).toBe(0);
    expect(result.sidecarExitedCleanly).toBe(true);
    expect(result.taskkillEscalated).toBe(false);

    // The real ExitCodeNotification fired the per-session onExit
    // exactly once — the -1 crash sentinel was NOT fired.
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
      // Yield so SIGTERM is dispatched.
      await Promise.resolve();
      await Promise.resolve();
      // Ack the SIGTERM but DO NOT emit ExitCodeNotification — the
      // sidecar "child ignores SIGTERM" scenario.
      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the per-session timeout — the drain escalates to
      // SIGKILL.
      await vi.advanceTimersByTimeAsync(2_001);
      // Ack the SIGKILL.
      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
      // Emit the late ExitCodeNotification (best-effort tick) so
      // teardown bookkeeping can complete.
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

      // Sidecar exits cleanly on its own after the per-session drains.
      fake.triggerExit(0, null);
      await Promise.resolve();
      await Promise.resolve();

      const result = await drainPromise;
      expect(result.sessionsDrained).toBe(0);
      expect(result.sessionsForcedKilled).toBe(1);

      // Assert SIGKILL was dispatched after SIGTERM.
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
    // Sidecar acks SIGTERM + emits ExitCodeNotification for the
    // session.
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    fake.writeStdout(
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
    );
    // Yield multiple times so per-session `Promise.all` settles and
    // `drainSidecarHost` runs to the point of calling `child.stdin.end()`.
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // After per-session drains, the supervisor MUST close stdin.
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
      // Per-session drain succeeds.
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

      // Sidecar does NOT exit on stdin close — advance past the host
      // timeout.
      await vi.advanceTimersByTimeAsync(2_001);
      await Promise.resolve();
      await Promise.resolve();

      // Now allow the synthetic exit to fire so the drain resolves
      // (the host escalation issued child.kill("SIGKILL") and is
      // returning immediately).
      fake.triggerExit(0, null);
      await Promise.resolve();
      await Promise.resolve();

      const result = await drainPromise;
      expect(result.sidecarExitedCleanly).toBe(false);
      expect(result.taskkillEscalated).toBe(true);

      // Assert the supervisor called child.kill("SIGKILL") on the
      // host-timeout escalation path.
      expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
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
      // Sidecar acks SIGTERM but DOES NOT emit ExitCodeNotification
      // for s-0 — simulating a sidecar where the per-session child
      // exited before its notification reached the wire.
      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
      await Promise.resolve();
      await Promise.resolve();

      // Per-session drain races against the per-session timeout —
      // since no ExitCodeNotification arrived, advance past the
      // per-session timeout so the drain escalates to SIGKILL.
      await vi.advanceTimersByTimeAsync(2_001);
      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
      await Promise.resolve();
      await Promise.resolve();

      // Sidecar exits — the canonical teardown chain runs (parser
      // reset, fireCrashTimeOnExit, etc.). The SIGKILL synthetic
      // already set `record.exitCode = 1`, so the natural
      // `record.exitCode === null` dedupe in `fireCrashTimeOnExit`
      // skips s-0 — no spurious `-1` fires.
      fake.triggerExit(0, null);
      await Promise.resolve();
      await Promise.resolve();

      await drainPromise;

      // Contract surface (`packages/contracts/src/pty-host.ts:173-180`):
      // "The session's `onExit` listener still fires (either from the
      // real exit notification arriving late or from a synthetic
      // emission per the SIGKILL escalation path), but the drain was
      // non-graceful."
      //
      // Per ADR-019 §Decision item 8 ("Consumers never see the
      // backend choice"), the rust-sidecar backend MUST mirror
      // `NodePtyHost.invokeTaskkill` (node-pty-host.ts:1117-1127),
      // which synthesizes `onExit(sessionId, 1, undefined)` on the
      // taskkill-escalation path. The synthetic uses exit code `1`
      // (not the `-1` crash sentinel) — `-1` is reserved for
      // unexpected-crash teardown via `fireCrashTimeOnExit`.
      //
      // Assert the synthetic emission contract:
      //   (a) exactly one onExit fired for s-0;
      //   (b) signature is (sessionId='s-0', exitCode=1) with
      //       signalCode undefined (omitted by `fireExit`'s
      //       branch — see rust-sidecar-pty-host.ts fireExit
      //       rustdoc);
      //   (c) the `-1` crash sentinel was NOT fired (complementary
      //       assertion: the suppression of the crash teardown sentinel
      //       still holds during shutdown).
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith("s-0", 1);
      const negOneCalls = onExit.mock.calls.filter((call) => call[1] === -1);
      expect(negOneCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits -1 onExit for sessions whose real ExitCodeNotification never arrived when sidecar crashes mid-shutdown", async () => {
    // Case-3 contract pin: during `shutdown()`, if the sidecar process
    // exits unexpectedly (crash, SIGSEGV, etc.) BEFORE every active
    // session's real `ExitCodeNotification` has reached the wire,
    // `fireCrashTimeOnExit` MUST emit the `-1` synthetic for the
    // sessions whose real exit was lost. Suppressing it during
    // shutdown leaves the consumer waiting forever and violates the
    // exactly-once `PtyHost.onExit` contract.
    //
    // Dedupe is via `record.exitCode !== null`. The two real-exit
    // setters (`handleExitNotification` and the SIGKILL synthetic)
    // both set `record.exitCode` BEFORE calling `fireExit`, so any
    // session that already saw a real or forced exit is skipped.
    //
    // Trace:
    //   * s-A: real `ExitCodeNotification` arrives → `record.exitCode
    //     = 0`, `onExit(s-A, 0)` fires. When the sidecar later crashes
    //     and `fireCrashTimeOnExit` runs, A is skipped (non-null
    //     record).
    //   * s-B: NO real exit arrives. When the sidecar crashes,
    //     `fireCrashTimeOnExit` sees `record.exitCode === null` and
    //     fires `onExit(s-B, -1, undefined)`. B is then deleted from
    //     `this.sessions`. B's `drainSingleSession` waiter falls
    //     through to its per-session timeout → SIGKILL escalation;
    //     the SIGKILL synthetic observes `record === undefined` (B
    //     was already deleted) and no-ops. B counts under
    //     `sessionsForcedKilled` (the drain returned `"forced"`).
    //
    // Refs:
    //   • Plan-001 §CP-001-1 sidecar-lifecycle drain.
    //   • `packages/contracts/src/pty-host.ts` PtyHost.onExit contract
    //     (exactly-once per session terminal callback).

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
      // Yield so per-session SIGTERMs reach the wire.
      await Promise.resolve();
      await Promise.resolve();

      // Sidecar acks both SIGTERMs.
      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-A" }));
      fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-B" }));
      // s-A's real ExitCodeNotification arrives (simulating partial
      // drain — sidecar processed A's kill but crashes before B's).
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

      // Synthesize the sidecar crash — fires handleChildExit which
      // runs fireCrashTimeOnExit. s-A is skipped via the natural
      // dedupe (record.exitCode = 0), s-B receives the `-1` synthetic
      // because its record.exitCode is still null.
      fake.triggerExit(null, "SIGSEGV");
      await Promise.resolve();
      await Promise.resolve();

      // s-B's per-session drain waiter never resolved (no real exit,
      // no SIGKILL synthetic because record was deleted by
      // fireCrashTimeOnExit). Advance past the per-session timeout
      // so drainSingleSession falls through to its SIGKILL
      // escalation path and returns "forced".
      await vi.advanceTimersByTimeAsync(1_001);
      await Promise.resolve();
      await Promise.resolve();

      const result = await drainPromise;

      // Assertion 1: s-A received exactly one onExit with the real
      // exit code from the real ExitCodeNotification — NOT `-1`. The
      // dedupe via record.exitCode !== null held.
      const aCalls = onExit.mock.calls.filter((call) => call[0] === "s-A");
      expect(aCalls).toHaveLength(1);
      expect(aCalls[0]).toEqual(["s-A", 0]);

      // Assertion 2: s-B received exactly one onExit with code -1.
      // The `-1` synthetic fired because record.exitCode was null
      // when fireCrashTimeOnExit ran. The signalCode argument was
      // undefined per fireExit's branch behavior.
      const bCalls = onExit.mock.calls.filter((call) => call[0] === "s-B");
      expect(bCalls).toHaveLength(1);
      expect(bCalls[0]).toEqual(["s-B", -1]);

      // Assertion 3: total onExit count is exactly 2 (one per
      // session). No spurious double-fire.
      expect(onExit).toHaveBeenCalledTimes(2);

      // Assertion 4: both sessions are gone from the host's internal
      // map. Probe via the public `kill()` surface — it sync-throws
      // "unknown sessionId" when the id is not in `this.sessions`
      // (mirrors the public probe at line 664 above).
      await expect(host.kill("s-A", "SIGTERM")).rejects.toThrow(/unknown sessionId/);
      await expect(host.kill("s-B", "SIGTERM")).rejects.toThrow(/unknown sessionId/);

      // Assertion 5: s-B counts under sessionsForcedKilled (its
      // drainSingleSession waiter never resolved naturally; it fell
      // through to the per-session timeout). s-A counts under
      // sessionsDrained (its real ExitCodeNotification arrived in
      // time).
      expect(result.sessionsDrained).toBe(1);
      expect(result.sessionsForcedKilled).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forced-kills a session when sidecar IPC is wedged and kill_response never arrives within perSessionTimeoutMs", async () => {
    // Wedge-scenario regression pin (Codex P1 on commit b3c984e of PR
    // #83, discussion r3271742909): the prior shape in
    // `drainSingleSession` awaited `sendRequest(SIGTERM kill_request)`
    // BEFORE arming the per-session timer. A wedged sidecar (process
    // alive, IPC dispatcher unresponsive) would never enqueue a
    // `kill_response`, so the `await` hung forever, the per-session
    // `setTimeout` was never armed, `drainSingleSession` never
    // returned, `Promise.all(activeSessionIds.map(drainSingleSession,
    // ...))` in `runShutdown` blocked forever, `drainSidecarHost`
    // never ran, and the outer `hardCap` in `sidecar-lifecycle.ts`
    // fired with `shutdownPromise` (memoized at L1189) stuck pending
    // — locking every future `shutdown()` call onto that dead promise
    // via the re-entrancy gate.
    //
    // Discriminator shape: drop the `kill_request` envelope entirely
    // (the wedge IS unboundedness, NOT slowness — a delayed
    // `kill_response` mock would still resolve the await eventually
    // and miss the bug). The child process stays alive (no
    // `triggerExit`). `shutdownWaiters` is never ticked. Under the
    // FIXED code, the per-session timer is armed BEFORE the IPC
    // await (the `gracefulDrain` wrapper races against
    // `timeoutPromise` at the Promise.race level), so the timeout
    // fires at `perSessionTimeoutMs` regardless of the wedge, the
    // SIGKILL synthetic emits `onExit(session, 1, undefined)`, and
    // `drainSingleSession` returns `"forced"`.
    //
    // Bug-revert verification: under the REVERTED code (await before
    // timer arm), the test hangs past vitest's per-test timeout (5s
    // by default) and fails with a timeout error. We do NOT modify
    // production to verify — the test structure (drop `kill_request`,
    // no `triggerExit`, single fake-timer advance past
    // `perSessionTimeoutMs`) is the structural pin.
    //
    // Refs:
    //   • Plan-001 §CP-001-1 sidecar-lifecycle drain.
    //   • PR #83 discussion r3271742909 (Codex P1 finding).
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
      // Yield so `sendRequest(kill_request{SIGTERM})` reaches the
      // wire and the `gracefulDrain` async wrapper parks on the
      // outstanding-response queue.
      await Promise.resolve();
      await Promise.resolve();

      // Verify the SIGTERM kill_request reached the wire — establishes
      // that the wedge scenario is mid-flight (request sent, response
      // never coming).
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

      // Pre-condition: synthetic onExit has NOT fired yet — the
      // per-session timer has not been advanced.
      expect(onExit).not.toHaveBeenCalled();

      // Advance past the per-session timeout. Under the FIXED code,
      // this fires the timer that `gracefulDrain` races against; the
      // race resolves on "timeout"; the SIGKILL synthetic emits
      // `onExit(s-0, 1, undefined)` and `drainSingleSession` returns
      // `"forced"`. Under the BUGGY code (timer armed AFTER the IPC
      // await), advancing this timer is a no-op because the timer was
      // never armed; the test hangs at the awaiting `drainPromise`
      // below.
      await vi.advanceTimersByTimeAsync(51);

      // The synthetic forced-kill onExit fired exactly once on the
      // SIGKILL escalation path. Signature is `(sessionId, 1)` — the
      // signalCode argument is undefined (omitted by `fireExit`'s
      // branch) and `onExit(sessionId, exitCode, signalCode?)` is
      // invoked with 2 args.
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith("s-0", 1);

      // The SIGKILL escalation reached the wire as a fire-and-forget
      // `sendRequest` (the second kill_request frame after the dropped
      // SIGTERM). The fake captures it on stdin even though the test
      // never enqueues a kill_response for it.
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

      // The per-session drain has now returned "forced", so
      // `runShutdown` proceeds to `drainSidecarHost`. The sidecar is
      // still alive (the wedge) and the host's `child.stdin.end()`
      // call does not trigger an exit — advance past the host timeout
      // so the host wind-down escalates via `child.kill("SIGKILL")`.
      await vi.advanceTimersByTimeAsync(501);
      await Promise.resolve();
      await Promise.resolve();

      const result = await drainPromise;

      // The session counts under `sessionsForcedKilled`, NOT
      // `sessionsDrained` — the SIGTERM IPC never acked, the real
      // `ExitCodeNotification` never arrived, the drain returned
      // "forced" via the per-session timer.
      expect(result.sessionsDrained).toBe(0);
      expect(result.sessionsForcedKilled).toBe(1);

      // Host wind-down also escalated (the sidecar stayed wedged and
      // ignored stdin EOF too). `child.kill("SIGKILL")` was the
      // bounded OS-signal backstop per ADR-019 §Decision item 8.
      expect(result.sidecarExitedCleanly).toBe(false);
      expect(result.taskkillEscalated).toBe(true);
      expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces a session when sidecar crashes mid-shutdown after SIGTERM IPC rejects via rejectAllOutstanding", async () => {
    // f4b1ff5 crash-case regression check (single-session shape — the
    // existing two-session crash test at ~L531 covers the multi-
    // session interaction). When the sidecar crashes mid-drain
    // BEFORE acking the SIGTERM `kill_request`, the trace is:
    //
    //   1. `drainSingleSession` enters, installs `shutdownWaiters[s-0]`,
    //      starts `gracefulDrain` (which awaits SIGTERM `sendRequest`).
    //   2. Fake sidecar receives `kill_request{SIGTERM}`. Before
    //      enqueueing a `kill_response`, the sidecar process exits.
    //   3. `handleChildExit` runs:
    //        (a) `fireCrashTimeOnExit` — sees `s-0` with
    //            `record.exitCode === null`, fires the `-1` synthetic
    //            `onExit(s-0, -1, undefined)`, deletes the session
    //            record.
    //        (b) `rejectAllOutstanding` — rejects the pending
    //            `sendRequest` with the crash-attribution error.
    //        (c) `notifyHostExitWaiter` — no-op (drain not yet in
    //            `drainSidecarHost`).
    //   4. Back in `gracefulDrain`: the SIGTERM `sendRequest` rejected
    //      → caught (swallowed) → await `drainWaiter`. But
    //      `fireCrashTimeOnExit` does NOT itself call
    //      `notifyShutdownWaiter` (verified at L1794-1799 + L2926-2944
    //      of the production source) — so `drainWaiter` stays pending.
    //   5. The per-session timer fires (armed BEFORE the await per
    //      the b3c984e fix) → race resolves on "timeout" →
    //      `gracefulDrain` is discarded.
    //   6. SIGKILL escalation path: synthetic gate observes
    //      `record === undefined` (deleted in step 3a) → skip both the
    //      `fireExit(s-0, 1, ...)` and `notifyShutdownWaiter` calls.
    //      `drainSingleSession` returns `"forced"`.
    //   7. `drainSidecarHost`: `this.child === null` (cleared in step 3
    //      pre-`fireCrashTimeOnExit`) → returns vacuous clean.
    //
    // Net consumer observation: exactly one `onExit(s-0, -1)` (from
    // step 3a), `sessionsForcedKilled === 1` (the drain returned
    // "forced"), `sessionsDrained === 0`, `sidecarExitedCleanly: true`
    // (vacuous — the child was already gone by host wind-down). The
    // `-1` sentinel is the CRASH signal, distinct from the `1`
    // forced-kill synthetic emitted by the SIGKILL escalation on a
    // LIVE sidecar (covered by the wedge test above).
    //
    // Refs:
    //   • Plan-001 §CP-001-1 sidecar-lifecycle drain.
    //   • Existing two-session crash test at ~L531 (this is the
    //     single-session variant — same trace, no s-A drained path).
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
      // Yield so SIGTERM `kill_request` reaches the wire and the
      // `gracefulDrain` async wrapper parks on the outstanding-
      // response queue.
      await Promise.resolve();
      await Promise.resolve();

      // Simulate the sidecar process crashing BEFORE acking SIGTERM.
      // This drives `handleChildExit` → `fireCrashTimeOnExit` (fires
      // `-1` synthetic, deletes record) → `rejectAllOutstanding`
      // (rejects the pending sendRequest).
      fake.triggerExit(null, "SIGSEGV");
      await Promise.resolve();
      await Promise.resolve();

      // The `-1` crash synthetic already fired from
      // `fireCrashTimeOnExit`. The SIGKILL escalation path has not
      // yet been reached — the per-session timer is still pending.
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith("s-0", -1);

      // Advance past the per-session timeout — the gracefulDrain
      // wrapper's await on `drainWaiter` is still pending (no
      // ExitCodeNotification arrived, fireCrashTimeOnExit does not
      // tick the waiter). Race resolves on "timeout" → SIGKILL
      // escalation → synthetic gate sees `record === undefined` →
      // skips → drain returns "forced".
      await vi.advanceTimersByTimeAsync(51);
      await Promise.resolve();
      await Promise.resolve();

      const result = await drainPromise;

      // The session counts under `sessionsForcedKilled` (drain
      // returned "forced" — its waiter never resolved naturally).
      expect(result.sessionsDrained).toBe(0);
      expect(result.sessionsForcedKilled).toBe(1);

      // No DOUBLE-fire: the SIGKILL synthetic's `record !== undefined`
      // gate skipped (record was deleted by `fireCrashTimeOnExit` in
      // step 3a). The `-1` from the crash sentinel is the only
      // `onExit` the consumer saw.
      expect(onExit).toHaveBeenCalledTimes(1);
      const calls = onExit.mock.calls;
      expect(calls[0]).toEqual(["s-0", -1]);

      // Host wind-down: `this.child` was cleared inside
      // `handleChildExit` (BEFORE `fireCrashTimeOnExit`), so
      // `drainSidecarHost`'s `child === null` early-return reports a
      // vacuous clean wind-down with no escalation.
      expect(result.sidecarExitedCleanly).toBe(true);
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

    // A concurrent spawn() attempt MUST be rejected — the host is
    // terminal after shutdown entry per the contract surface. This
    // is the discriminator for the `shuttingDown` flag in
    // `ensureChild`.
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

    // Complete the drain so the test cleans up.
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
    // Race shape this exercises (different from the previous test's
    // post-flag-flip path):
    //
    //   (1) Consumer issues `spawn(spec)` BEFORE shutdown().
    //       `ensureChild()` observes `shuttingDown === false` and
    //       returns; `spawn()` proceeds to `await sendRequest(...,
    //       "spawn_response")` and yields.
    //   (2) `shutdown()` flips `shuttingDown = true` and snapshots
    //       `activeSessionIds` — EMPTY because the new session has
    //       not been registered yet.
    //   (3) Fake sidecar emits `SpawnResponse` for the in-flight
    //       request AFTER the flag flip (simulating a sidecar that
    //       finished processing the queued SpawnRequest before its
    //       stdin EOF kill landed).
    //   (4) `resolveOutstanding`'s spawn_response branch re-checks
    //       `this.shuttingDown` and rejects the awaiting
    //       `spawn()` Promise with `PtyBackendUnavailableError`
    //       carrying the same shape as `ensureChild`'s pre-flag-
    //       flip rejection.
    //
    // Without the guard in `resolveOutstanding`, the session_id
    // would be registered post-snapshot, then deleted by
    // `fireCrashTimeOnExit` on sidecar exit (which suppresses the
    // `-1` sentinel under `shuttingDown === true`), and the
    // caller's subsequent `kill()` / `write()` / `resize()` would
    // throw "unknown sessionId" — a contract break per
    // ADR-019 §Decision item 8.
    //
    // Refs:
    //   • Plan-001 §CP-001-1 sidecar-lifecycle drain.
    //   • `PtyBackendUnavailableError` shape matches the existing
    //     post-flag-flip path tested above.

    const fake = makeFakeSidecarChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // Issue spawn() WITHOUT awaiting — capture the in-flight
    // Promise so we can drive the race deterministically. The
    // request reaches the wire after `ensureChild()` completes and
    // `sendRequest` enqueues the outstanding entry.
    const spawnPromise = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: ["-c", "sleep 10"],
      env: [],
      cwd: "/tmp",
      rows: 24,
      cols: 80,
    });

    // Yield enough microtasks for `ensureChild()` to complete and
    // `sendRequest` to write the SpawnRequest envelope onto stdin.
    await flushMicrotasks();
    await flushMicrotasks();

    // Confirm the SpawnRequest reached the wire — establishes that
    // `ensureChild()` observed `shuttingDown === false` and the
    // outstanding entry is parked awaiting its response.
    const framesBeforeShutdown = parseFramesFromStdin(fake.readStdin());
    expect(framesBeforeShutdown.some((envelope) => envelope.kind === "spawn_request")).toBe(true);

    // Trigger `shutdown()` — flips `shuttingDown = true` and
    // snapshots `activeSessionIds` (empty, because the in-flight
    // spawn hasn't registered yet). The drain loop completes
    // immediately because there are no sessions to drain.
    const drainPromise = host.shutdown({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });
    // Yield so the synchronous `shuttingDown = true` + activeSessionIds
    // snapshot completes BEFORE the fake emits SpawnResponse.
    await flushMicrotasks();

    // Fake sidecar emits SpawnResponse AFTER the flag flip. This is
    // the would-be orphan registration — the guard in
    // `resolveOutstanding` must intercept and reject instead of
    // calling `this.sessions.set(...)`.
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-orphan" }));
    await flushMicrotasks();

    // Assert: the in-flight spawn() rejected with the same shape as
    // `ensureChild()`'s pre-flag-flip rejection.
    await expect(spawnPromise).rejects.toBeInstanceOf(PtyBackendUnavailableError);

    // Externally observable invariant: subsequent kill() against the
    // would-be session_id throws "unknown sessionId" — the orphan
    // never landed in `this.sessions`. (`host.kill(sessionId, ...)`
    // sync-throws on unknown ids per the RustSidecarPtyHost.kill
    // rustdoc; this is the public probe for the private
    // `sessions.has(sessionId) === false` invariant the guard
    // enforces.)
    await expect(host.kill("s-orphan", "SIGTERM")).rejects.toThrow(/unknown sessionId/);

    // Complete the drain so the test cleans up. The sidecar exit
    // closes out the host wind-down.
    fake.triggerExit(0, null);
    await flushMicrotasks();

    const result = await drainPromise;
    // Snapshot was empty → drain counters are zero.
    expect(result.sessionsDrained).toBe(0);
    expect(result.sessionsForcedKilled).toBe(0);
    // Sidecar exited cleanly on stdin EOF; no taskkill escalation.
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

    // Complete the drain.
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
});
