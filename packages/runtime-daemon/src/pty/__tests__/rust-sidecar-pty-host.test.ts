// Tests for `RustSidecarPtyHost` — daemon-side supervisor for the Rust
// PTY sidecar binary.
//
// What we assert (Plan-024 Phase 3 acceptance criteria):
//
//   * AC1: every `PtyHost` method is implemented (spawn, resize, write,
//     kill, close, onData, onExit). Round-trip framing is exercised
//     end-to-end via a fake child process whose stdin/stdout streams
//     are wired to the supervisor's framer.
//   * AC2: AC2 ("PtyHostSelector returns a working host on Windows") is
//     covered by the selector test suite — this file focuses on the
//     supervisor surface itself.
//   * AC3: sidecar process crash within the respawn budget triggers
//     automatic respawn; outside budget surfaces
//     `PtyBackendUnavailableError`. Both branches exercised with a
//     mock-clock so the 60s sliding window is deterministic.
//   * Pin 1: factory accepts `binaryPath` so T-024-3-3 can swap the
//     resolver without touching the signature.
//   * Pin 4: Content-Length frames written to stdin match the wire
//     format `Content-Length: <bytes>\r\n\r\n<json-payload>`.
//   * Pin 5: crash budget is a sliding window — 5 crashes at t=10s
//     followed by a 6th crash at t=70s does NOT exhaust because the
//     first 5 are evicted before the 6th is recorded.
//
// Transport mock — `child_process.spawn`:
// ----------------------------------------
//
// The supervisor consumes a `SidecarSpawnFn` injected via deps. We
// construct a fake `ChildProcess`-shaped object using
// `node:stream.PassThrough` for stdin/stdout/stderr and `node:events.
// EventEmitter` for the `on('exit')` / `on('error')` surface. Each
// test scenario builds a fresh fake and wires the supervisor against
// it.
//
// Refs: Plan-024 §F-024-3-02 + §F-024-3-05; ADR-019 §Decision item 1.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { sep as pathSep } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  CRASH_BUDGET_LIMIT,
  CRASH_BUDGET_WINDOW_MS,
  ContentLengthParser,
  MAX_FRAME_BODY_BYTES,
  PtyBackendUnavailableError,
  RustSidecarPtyHost,
  createRustSidecarPtyHost,
  resolveSidecarBinaryPath,
  type ResolveSidecarBinaryPathOptions,
  type SidecarChildProcess,
  type SidecarSpawnFn,
} from "../rust-sidecar-pty-host.js";

import { PTY_BACKEND_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts";
import type { Envelope } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Fake child process — minimal shape mirroring node:child_process.
// ----------------------------------------------------------------------------

/**
 * Fake child process whose stdin/stdout/stderr are PassThrough
 * streams. Tests can read from `stdin` to inspect what the supervisor
 * wrote, write to `stdout` to deliver synthetic responses, and call
 * `triggerExit`/`triggerError` to simulate child lifecycle events.
 */
interface FakeChild {
  readonly child: SidecarChildProcess;
  /** Reads frames written by the supervisor to stdin. */
  readStdin(): Buffer;
  /** Send raw bytes from the "sidecar" back to the supervisor. */
  writeStdout(bytes: Buffer | string): void;
  /** Trigger the `exit` event with the given code/signal. */
  triggerExit(code: number | null, signal: string | null): void;
  /** Trigger the `error` event. */
  triggerError(err: Error): void;
}

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const ee = new EventEmitter();

  // Buffer everything written to stdin so the test can inspect.
  const stdinChunks: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => {
    stdinChunks.push(chunk);
  });

  // Implementation of the `on` overload signature. The two named
  // listener shapes (exit: (code, signal); error: (err)) cannot be
  // expressed as a single union-signature object literal under
  // strict checking — but a function-property whose signature is
  // declared via overload and implemented with a permissive body
  // satisfies the discriminated overload. We declare two overloaded
  // signatures for type-side parity and a single permissive impl
  // that defers to the EventEmitter.
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
    pid: 12345,
    stdin: stdin,
    stdout: stdout,
    stderr: stderr,
    on,
    kill: vi.fn(() => true),
  };

  return {
    child,
    readStdin: () => Buffer.concat(stdinChunks),
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

/**
 * Build a `SidecarSpawnFn` stub that returns the provided fake child
 * (cast to the Node-typed `ChildProcessWithoutNullStreams` for the
 * deps interface — the supervisor only consumes the
 * `SidecarChildProcess` subset).
 */
function spawnReturning(fake: FakeChild): SidecarSpawnFn {
  return vi
    .fn<SidecarSpawnFn>()
    .mockImplementation(() => fake.child as unknown as ReturnType<SidecarSpawnFn>);
}

/**
 * Build a `SidecarSpawnFn` stub that returns a fresh fake on each
 * call — useful for crash-respawn tests where the supervisor needs
 * to spawn N children sequentially. Returns the spawn fn AND an
 * accessor for the most-recently-spawned fake so the test can drive
 * its lifecycle.
 */
function spawnReturningSequence(): {
  spawn: SidecarSpawnFn;
  latest: () => FakeChild;
  spawned: () => readonly FakeChild[];
} {
  const fakes: FakeChild[] = [];
  const spawn: SidecarSpawnFn = vi.fn<SidecarSpawnFn>().mockImplementation(() => {
    const fake = makeFakeChild();
    fakes.push(fake);
    return fake.child as unknown as ReturnType<SidecarSpawnFn>;
  });
  return {
    spawn,
    latest: () => {
      const f = fakes[fakes.length - 1];
      if (f === undefined) {
        throw new Error("spawnReturningSequence.latest: nothing spawned yet");
      }
      return f;
    },
    spawned: () => fakes,
  };
}

/**
 * Encode an inbound envelope as a Content-Length-framed buffer the
 * test can write to a fake child's stdout to simulate a sidecar
 * response.
 */
function frameEnvelope(envelope: Envelope): Buffer {
  const payload: Buffer = Buffer.from(JSON.stringify(envelope), "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

/**
 * Parse the stdin contents (a sequence of Content-Length frames) into
 * an array of envelopes. Used to inspect what the supervisor sent.
 */
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

/**
 * Microtask flush helper — yields to the event loop so async listener
 * dispatch (PassThrough `data` events) and Promise resolution can
 * complete before assertions run. Two `await Promise.resolve()` calls
 * are sufficient for the listener-then-promise chain we need; a
 * single `setImmediate`-style yield would also work but the explicit
 * Promise yields are deterministic across runtimes.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ----------------------------------------------------------------------------
// AC1 — every PtyHost method is implemented.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — PtyHost contract surface (AC1)", () => {
  it("spawn round-trips through the framer and resolves with the SpawnResponse", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // Fire spawn — supervisor writes the SpawnRequest frame and waits.
    const spawnPromise = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: ["-c", "echo hi"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    // Assert the supervisor wrote the request as a framed envelope.
    const envelopes = parseFramesFromStdin(fake.readStdin());
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      kind: "spawn_request",
      command: "/bin/sh",
      args: ["-c", "echo hi"],
      cwd: "/",
      rows: 24,
      cols: 80,
    });

    // Deliver the SpawnResponse from the fake sidecar.
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));

    const response = await spawnPromise;
    expect(response).toEqual({ kind: "spawn_response", session_id: "s-0" });
  });

  it("resize sends a ResizeRequest and resolves on ResizeResponse", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // Spawn first to register the session.
    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    // Now resize.
    const resizePromise = host.resize("s-0", 30, 100);
    await flushMicrotasks();
    const allFrames = parseFramesFromStdin(fake.readStdin());
    const resizeFrame = allFrames[allFrames.length - 1];
    expect(resizeFrame).toEqual({
      kind: "resize_request",
      session_id: "s-0",
      rows: 30,
      cols: 100,
    });

    fake.writeStdout(
      frameEnvelope({
        kind: "resize_response",
        session_id: "s-0",
      }),
    );
    await expect(resizePromise).resolves.toBeUndefined();
  });

  it("write base64-encodes the bytes per F-024-1-01 and resolves on WriteResponse", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    const payload = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    const writeP = host.write("s-0", payload);
    await flushMicrotasks();

    const all = parseFramesFromStdin(fake.readStdin());
    const writeFrame = all[all.length - 1];
    expect(writeFrame).toEqual({
      kind: "write_request",
      session_id: "s-0",
      // "hello" base64 = "aGVsbG8="
      bytes: "aGVsbG8=",
    });

    fake.writeStdout(frameEnvelope({ kind: "write_response", session_id: "s-0" }));
    await expect(writeP).resolves.toBeUndefined();
  });

  it("kill sends a KillRequest with the POSIX signal and resolves on KillResponse", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    const killP = host.kill("s-0", "SIGTERM");
    await flushMicrotasks();
    const all = parseFramesFromStdin(fake.readStdin());
    const killFrame = all[all.length - 1];
    expect(killFrame).toEqual({
      kind: "kill_request",
      session_id: "s-0",
      signal: "SIGTERM",
    });

    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(killP).resolves.toBeUndefined();
  });

  it("kill on already-exited session is idempotent (re-emits cached onExit, no wire dispatch)", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const exitFn = vi.fn();
    host.setOnExit(exitFn);

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    // Deliver an ExitCodeNotification to populate the exit cache.
    fake.writeStdout(
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
    );
    await flushMicrotasks();
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith("s-0", 0);

    // A subsequent kill on the same session re-emits onExit from
    // the cache and does NOT dispatch a wire request.
    const stdinBefore = fake.readStdin().length;
    await host.kill("s-0", "SIGKILL");
    await flushMicrotasks();
    expect(exitFn).toHaveBeenCalledTimes(2);
    // No new bytes written to stdin (the kill short-circuited on
    // the cached exit).
    expect(fake.readStdin().length).toBe(stdinBefore);
  });

  it("close on unknown sessionId is a no-op (idempotent)", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });
    // Never spawned — the session table is empty. close MUST NOT
    // throw, and MUST NOT trigger a sidecar spawn.
    await expect(host.close("s-bogus")).resolves.toBeUndefined();
  });

  it("onData fans out DataFrame chunks to the registered listener (base64-decoded)", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const dataFn = vi.fn();
    host.setOnData(dataFn);

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    // Deliver a DataFrame with base64 of "world".
    const worldB64 = Buffer.from("world", "utf8").toString("base64");
    fake.writeStdout(
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: worldB64,
      }),
    );
    await flushMicrotasks();

    expect(dataFn).toHaveBeenCalledTimes(1);
    const [sessionId, chunk] = dataFn.mock.calls[0]!;
    expect(sessionId).toBe("s-0");
    expect(Buffer.from(chunk).toString("utf8")).toBe("world");
  });
});

// ----------------------------------------------------------------------------
// Pin 4 — wire format check.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — Content-Length wire format (Pin 4)", () => {
  it("frames written to stdin use Content-Length: <bytes>\\r\\n\\r\\n<json> shape", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    void host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    const stdin = fake.readStdin().toString("utf8");
    // Strict wire-format match — the header line MUST be exactly
    // "Content-Length: <n>\r\n\r\n" before the JSON body. A future
    // refactor that adds optional headers (Content-Type, etc.) MUST
    // keep Content-Length as the first header line for ADR-009 parity.
    expect(stdin).toMatch(/^Content-Length: \d+\r\n\r\n\{/);
  });
});

// ----------------------------------------------------------------------------
// AC3 + Pin 5 — sliding-window crash budget.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — sliding-window crash budget (AC3 + Pin 5)", () => {
  it("respawns the sidecar within budget (4 crashes in 60s does NOT exhaust)", async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Trigger 4 crashes at well-spaced timestamps within the
    // sliding 60s window. After each crash the supervisor must be
    // willing to respawn on the next request.
    for (let i = 0; i < 4; i += 1) {
      clock.mockReturnValue(i * 1000);
      // First request triggers the (re)spawn.
      const reqPromise = host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      });
      await flushMicrotasks();
      // Crash the just-spawned child before the supervisor can
      // resolve the request — this exercises the budget without
      // requiring a synthetic SpawnResponse.
      seq.latest().triggerExit(1, null);
      // The pending request rejects with the "sidecar exited"
      // message; we await with `.catch` to avoid an unhandled
      // rejection.
      await reqPromise.catch(() => undefined);
    }
    expect(seq.spawned().length).toBe(4);

    // 5th request should still be allowed — only 4 crashes in the
    // sliding window so far. The supervisor respawns rather than
    // surfacing PtyBackendUnavailable.
    clock.mockReturnValue(4 * 1000);
    void host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    expect(seq.spawned().length).toBe(5);
  });

  it(`exhausts the budget at exactly ${CRASH_BUDGET_LIMIT} crashes within ${CRASH_BUDGET_WINDOW_MS}ms (surfaces PtyBackendUnavailableError)`, async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Drive CRASH_BUDGET_LIMIT crashes within the window — the
    // last one trips the budget and marks the host permanently
    // unavailable.
    for (let i = 0; i < CRASH_BUDGET_LIMIT; i += 1) {
      clock.mockReturnValue(i * 1000);
      const reqP = host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      });
      await flushMicrotasks();
      seq.latest().triggerExit(1, null);
      await reqP.catch(() => undefined);
    }

    // Next request after the budget is exhausted MUST surface
    // PtyBackendUnavailableError with attemptedBackend=rust-sidecar.
    clock.mockReturnValue(CRASH_BUDGET_LIMIT * 1000);
    let thrown: unknown = null;
    try {
      await host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.code).toBe(PTY_BACKEND_UNAVAILABLE_CODE);
      expect(thrown.details.attemptedBackend).toBe("rust-sidecar");
    }
  });

  it("evicts crash entries older than the window (Pin 5 sliding-window correctness)", async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Record CRASH_BUDGET_LIMIT - 1 crashes at t=0..3s.
    for (let i = 0; i < CRASH_BUDGET_LIMIT - 1; i += 1) {
      clock.mockReturnValue(i * 1000);
      const reqP = host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      });
      await flushMicrotasks();
      seq.latest().triggerExit(1, null);
      await reqP.catch(() => undefined);
    }

    // Advance past the sliding window and crash again. The earlier
    // crashes are evicted; the new crash starts a fresh window
    // with a single entry. The host MUST still be willing to
    // respawn.
    clock.mockReturnValue(CRASH_BUDGET_WINDOW_MS + 5000);
    const reqP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    seq.latest().triggerExit(1, null);
    await reqP.catch(() => undefined);

    // We should be able to spawn again — only 1 crash in the
    // current sliding window.
    clock.mockReturnValue(CRASH_BUDGET_WINDOW_MS + 6000);
    void host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    // CRASH_BUDGET_LIMIT - 1 + 1 + 1 = CRASH_BUDGET_LIMIT + 1
    // spawn calls total. The post-eviction respawn IS allowed.
    expect(seq.spawned().length).toBe(CRASH_BUDGET_LIMIT + 1);
  });

  it("synchronous spawn failure (binary missing) consumes the crash budget too", async () => {
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const failingSpawn: SidecarSpawnFn = vi.fn<SidecarSpawnFn>().mockImplementation(() => {
      const e = new Error("ENOENT") as Error & { code?: string };
      e.code = "ENOENT";
      throw e;
    });
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: failingSpawn,
      nowMs: clock,
    });

    // Drive CRASH_BUDGET_LIMIT spawn failures.
    for (let i = 0; i < CRASH_BUDGET_LIMIT; i += 1) {
      clock.mockReturnValue(i * 1000);
      let caught: unknown = null;
      try {
        await host.spawn({
          kind: "spawn_request",
          command: "/bin/sh",
          args: [],
          env: [],
          cwd: "/",
          rows: 24,
          cols: 80,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PtyBackendUnavailableError);
    }

    // Subsequent spawn surfaces the budget-exhausted message rather
    // than the per-spawn ENOENT error — same shape, different
    // diagnostic message that names the budget.
    clock.mockReturnValue(CRASH_BUDGET_LIMIT * 1000);
    let last: unknown = null;
    try {
      await host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      });
    } catch (err) {
      last = err;
    }
    expect(last).toBeInstanceOf(PtyBackendUnavailableError);
    if (last instanceof PtyBackendUnavailableError) {
      expect(last.message).toMatch(/crash-respawn budget exhausted/);
    }
  });
});

// ----------------------------------------------------------------------------
// Resolver failure path — binary path resolution itself fails.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — binary path resolver failure", () => {
  it("surfaces PtyBackendUnavailableError when resolveBinaryPath throws", async () => {
    const cause = new Error("not found");
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => {
        throw cause;
      },
      // Spawn should never be reached; assert on that too.
      spawn: vi.fn<SidecarSpawnFn>(),
    });

    let thrown: unknown = null;
    try {
      await host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.details.attemptedBackend).toBe("rust-sidecar");
      expect(thrown.details.cause).toBe(cause);
    }
  });
});

// ----------------------------------------------------------------------------
// Factory — `createRustSidecarPtyHost` accepts an optional `binaryPath`.
// ----------------------------------------------------------------------------

describe("createRustSidecarPtyHost — factory accepts binaryPath", () => {
  it("constructs a host whose internal resolver returns the supplied binaryPath", async () => {
    // We cannot directly inspect the internal resolver from outside
    // the class, but the factory's `binaryPath` opt is end-to-end
    // exercised via the selector tests. Here we assert the factory
    // does not throw and returns an instance.
    const host = createRustSidecarPtyHost({ binaryPath: "/explicit/path" });
    expect(host).toBeInstanceOf(RustSidecarPtyHost);
  });

  it("constructs a host with no opts (production default — wires the four-tier resolver)", () => {
    // No-opt construction wires `resolveSidecarBinaryPath` as the
    // default `resolveBinaryPath` deps entry. The four-tier resolver's
    // own behavior is exercised in the dedicated `resolveSidecarBinaryPath`
    // describe block below; here we just assert construction succeeds.
    const host = createRustSidecarPtyHost();
    expect(host).toBeInstanceOf(RustSidecarPtyHost);
  });
});

// ----------------------------------------------------------------------------
// Frame body cap — defense in depth on inbound corruption.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — framing limits (defense in depth)", () => {
  it(`MAX_FRAME_BODY_BYTES is set to ${MAX_FRAME_BODY_BYTES} bytes (mirrors Rust framing::MAX_FRAME_BODY_BYTES)`, () => {
    // Pin the constant value so a future divergence from the Rust
    // side trips this test. 8 MiB is the contract per Plan-024
    // F-024-1-06.
    expect(MAX_FRAME_BODY_BYTES).toBe(8 * 1024 * 1024);
  });
});

// ----------------------------------------------------------------------------
// `ContentLengthParser` direct-drive tests — depth coverage of the framer's
// rejection paths and chunk-boundary reassembly. These exercise the framer
// surface that the supervisor's stdout `data` listener feeds; without this
// coverage a parser-reset gap (residual bytes carried across a child crash)
// would surface only as flaky downstream decode failures.
// ----------------------------------------------------------------------------

describe("ContentLengthParser — chunk-boundary reassembly + rejection paths", () => {
  it("reassembles a frame split across two feed() calls (partial-read path)", () => {
    const parser = new ContentLengthParser();
    const body = Buffer.from('{"kind":"ping_response"}', "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    const full = Buffer.concat([header, body]);

    // Split the buffer mid-header — the harshest split point because
    // the parser cannot even locate the CRLFCRLF terminator on the
    // first feed.
    const splitAt = Math.floor(header.length / 2);
    parser.feed(full.subarray(0, splitAt));
    expect(parser.nextFrame()).toEqual({ kind: "incomplete" });

    parser.feed(full.subarray(splitAt));
    const result = parser.nextFrame();
    expect(result.kind).toBe("frame");
    if (result.kind === "frame") {
      expect(result.body.toString("utf8")).toBe('{"kind":"ping_response"}');
    }
  });

  it("reassembles a frame whose body is split across two feed() calls", () => {
    const parser = new ContentLengthParser();
    const body = Buffer.from('{"kind":"ping_response"}', "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    const full = Buffer.concat([header, body]);

    // Split mid-body — the parser has the header but a short body and
    // must return incomplete until the rest arrives.
    const splitAt = header.length + Math.floor(body.length / 2);
    parser.feed(full.subarray(0, splitAt));
    expect(parser.nextFrame()).toEqual({ kind: "incomplete" });

    parser.feed(full.subarray(splitAt));
    const result = parser.nextFrame();
    expect(result.kind).toBe("frame");
    if (result.kind === "frame") {
      expect(result.body.toString("utf8")).toBe('{"kind":"ping_response"}');
    }
  });

  it("drains multiple frames coalesced into a single feed() call", () => {
    // TCP coalescing can deliver many wire frames in one chunk. The
    // supervisor's `drainParserUntilIncomplete` loops; the parser
    // must hand them out one at a time without losing or merging
    // any.
    const parser = new ContentLengthParser();
    const bodies = [
      '{"kind":"ping_response"}',
      '{"kind":"resize_response","session_id":"s-0"}',
      '{"kind":"write_response","session_id":"s-1"}',
    ];
    const chunks = bodies.map((b) => {
      const body = Buffer.from(b, "utf8");
      const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
      return Buffer.concat([header, body]);
    });
    parser.feed(Buffer.concat(chunks));

    const decoded: string[] = [];
    for (;;) {
      const result = parser.nextFrame();
      if (result.kind === "incomplete") {
        break;
      }
      if (result.kind === "error") {
        throw new Error(`unexpected parser error: ${result.message}`);
      }
      decoded.push(result.body.toString("utf8"));
    }
    expect(decoded).toEqual(bodies);
  });

  it("rejects a frame missing the Content-Length header", () => {
    // The framer treats missing Content-Length as a fatal supervisor
    // event because we cannot determine the body length. The error
    // sentinel is the contract the supervisor uses to trigger a
    // SIGKILL respawn.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("Content-Type: text/plain\r\n\r\nbody", "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/missing Content-Length header/i);
    }
  });

  it("rejects a frame with duplicate Content-Length headers (request-smuggling shape)", () => {
    // Two Content-Length values is the canonical request-smuggling
    // attack shape. The Rust framer rejects this; the TS framer
    // rejects it too for symmetric defense in depth.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("Content-Length: 4\r\nContent-Length: 8\r\n\r\nbodybody", "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/duplicate Content-Length/i);
    }
  });

  it("rejects a Content-Length value that is not a non-negative integer", () => {
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("Content-Length: not-a-number\r\n\r\n", "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Content-Length value is not a valid non-negative integer/i);
    }
  });

  it(`rejects a body length larger than MAX_FRAME_BODY_BYTES (${MAX_FRAME_BODY_BYTES})`, () => {
    // We do NOT actually produce 8+ MiB of body here — the cap is
    // checked after the header parse, before the body bytes have
    // arrived. The parser MUST reject on the declared size alone.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from(`Content-Length: ${MAX_FRAME_BODY_BYTES + 1}\r\n\r\n`, "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/exceeds MAX_FRAME_BODY_BYTES/);
    }
  });
});

// ----------------------------------------------------------------------------
// Parser is reset on child exit so the next sidecar does not inherit
// corrupted buffer state from the prior child's mid-frame death.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — parser reset across respawn", () => {
  it("framing-error self-kill respawns with a fresh parser that decodes a fresh frame correctly", async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Spawn s-0 on the first sidecar; deliver a partial frame +
    // garbage that trips the framer's error sentinel.
    const spawnP1 = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    seq.latest().writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP1;

    // Inject a corrupting payload — Content-Length value that is not
    // a number. This hits the framer's error sentinel; the supervisor
    // SIGKILLs the child and waits for the exit handler to fire.
    const corruptHeader = Buffer.from("Content-Length: NOT_A_NUMBER\r\n\r\n", "utf8");
    seq.latest().writeStdout(corruptHeader);
    await flushMicrotasks();

    // The supervisor's drainParserUntilIncomplete catches the framing
    // error and calls child.kill("SIGKILL"). Verify on the fake.
    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    // Drive the exit event so the supervisor consumes the budget +
    // resets the parser + clears the child reference.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    // Now spawn again. The next request triggers ensureChild() which
    // creates the second sidecar AND wires the (newly-reset) parser
    // to its stdout. Deliver a fresh, well-formed SpawnResponse —
    // the parser MUST NOT be confused by the corrupting bytes from
    // the prior child.
    clock.mockReturnValue(200);
    const spawnP2 = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    expect(seq.spawned().length).toBe(2);

    seq.latest().writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    const response2 = await spawnP2;
    expect(response2).toEqual({ kind: "spawn_response", session_id: "s-1" });
  });

  it("residual partial-frame bytes from the prior child do NOT desync the next sidecar's frames", async () => {
    // Stronger version of the above. Inject a partial header on
    // child A, then deliver a complete frame on child B that lands
    // at byte offset 0 of a freshly-respawned parser. Without the
    // reset the partial bytes would contaminate the second frame.
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    const spawnP1 = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    seq.latest().writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP1;

    // Deliver only the FIRST half of a Content-Length header. The
    // parser holds these bytes in its internal buffer.
    seq.latest().writeStdout(Buffer.from("Content-Length: 27\r", "utf8"));
    await flushMicrotasks();

    // Crash the child. handleChildExit MUST reset the parser so the
    // residual bytes are discarded; otherwise the next sidecar would
    // start decoding into the prior child's half-buffered header.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(1, null);
    await flushMicrotasks();

    // Respawn + deliver a fresh well-formed frame.
    clock.mockReturnValue(200);
    const spawnP2 = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    seq.latest().writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    const response2 = await spawnP2;
    expect(response2).toEqual({ kind: "spawn_response", session_id: "s-1" });
  });
});

// ----------------------------------------------------------------------------
// Typed error response rejects the awaiting Promise — no indefinite hang
// on the close-races-natural-exit shape (kill_request arrives after the
// sidecar's child has already exited; sidecar replies with a typed error
// rather than the success-shape the daemon was awaiting).
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — sync throw on truly-unknown sessionId (NodePtyHost parity)", () => {
  it("kill() throws synchronously on a never-spawned sessionId (mirrors NodePtyHost)", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // Never spawned — session table is empty. kill MUST throw
    // synchronously (rejects via async wrapper but with the
    // never-have-touched-the-wire shape).
    await expect(host.kill("s-bogus", "SIGTERM")).rejects.toThrow(/unknown sessionId 's-bogus'/);
    // Stdin should be empty — no wire dispatch occurred.
    expect(fake.readStdin().length).toBe(0);
  });

  it("resize() throws synchronously on a never-spawned sessionId", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    await expect(host.resize("s-bogus", 30, 100)).rejects.toThrow(/unknown sessionId 's-bogus'/);
    expect(fake.readStdin().length).toBe(0);
  });

  it("write() throws synchronously on a never-spawned sessionId", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    await expect(host.write("s-bogus", new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /unknown sessionId 's-bogus'/,
    );
    expect(fake.readStdin().length).toBe(0);
  });
});

describe("RustSidecarPtyHost — wire-side error response rejects awaiting Promise", () => {
  it("kill on a known session that the sidecar has already removed rejects with a typed error (no indefinite hang)", async () => {
    // The race pinned here: daemon issued a close() which dispatches a
    // kill_request{SIGTERM}, sidecar's child exited naturally
    // microseconds before the request arrived, the sidecar's registry
    // returns UnknownSession, and the dispatcher emits a typed error
    // response (kill_response with error: Some). The daemon-side
    // resolveOutstanding MUST reject the awaiting Promise; without the
    // fix the Promise would sit in `outstanding` forever.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    // Daemon has the session — issue an explicit kill (NOT close,
    // close-swallow is exercised separately).
    const killP = host.kill("s-0", "SIGKILL");
    await flushMicrotasks();

    // Sidecar replies with a typed error response.
    fake.writeStdout(
      frameEnvelope({
        kind: "kill_response",
        session_id: "s-0",
        error: 'session_id "s-0" is not active',
      }),
    );

    await expect(killP).rejects.toThrow(
      /sidecar kill_response returned error.*session_id "s-0" is not active/,
    );
  });

  it("write on a known session that the sidecar has writer-unavailable for rejects with a typed error", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    const writeP = host.write("s-0", new Uint8Array([1]));
    await flushMicrotasks();
    fake.writeStdout(
      frameEnvelope({
        kind: "write_response",
        session_id: "s-0",
        error: 'writer for session "s-0" has already been taken',
      }),
    );

    await expect(writeP).rejects.toThrow(/sidecar write_response returned error/);
  });

  it("resize on a known session that the sidecar has unknown for rejects with a typed error", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    const resizeP = host.resize("s-0", 30, 100);
    await flushMicrotasks();
    fake.writeStdout(
      frameEnvelope({
        kind: "resize_response",
        session_id: "s-0",
        error: 'session_id "s-0" is not active',
      }),
    );

    await expect(resizeP).rejects.toThrow(/sidecar resize_response returned error/);
  });

  it("response with `error: undefined` (the success path) resolves normally and does NOT reject", async () => {
    // Pin the error-discrimination semantics. `error` absent on the
    // wire deserializes to `undefined`; the daemon MUST treat that
    // as success, not as a falsy-error.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    const killP = host.kill("s-0", "SIGTERM");
    await flushMicrotasks();
    // Deliver the success-path response — `error` field absent.
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(killP).resolves.toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// `close()` happy-path + swallow-on-error contract.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — close() lifecycle", () => {
  it("close() on a live session writes kill_request{SIGTERM} to stdin and resolves on the response", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    // Snapshot stdin so we can inspect ONLY the close-time bytes.
    const stdinBefore = fake.readStdin().length;

    const closeP = host.close("s-0");
    await flushMicrotasks();

    // Inspect the new bytes on stdin — must include a kill_request
    // with the SIGTERM signal (close's chosen graceful-stop signal).
    const allFrames = parseFramesFromStdin(fake.readStdin().subarray(stdinBefore));
    expect(allFrames).toHaveLength(1);
    expect(allFrames[0]).toEqual({
      kind: "kill_request",
      session_id: "s-0",
      signal: "SIGTERM",
    });

    // Deliver the success response — close resolves.
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(closeP).resolves.toBeUndefined();
  });

  it("close() swallows a wire-side error response (close MUST NOT throw on close-races-natural-exit)", async () => {
    // Pins the catch-and-swallow contract: a close() that races the
    // child's natural exit produces an UnknownSession on the sidecar
    // side, the typed error response routes through resolveOutstanding's
    // rejection branch, and close()'s try/catch swallows it. A
    // regression that drops the try/catch (or changes the signal from
    // SIGTERM) would trip this assertion.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    const closeP = host.close("s-0");
    await flushMicrotasks();
    fake.writeStdout(
      frameEnvelope({
        kind: "kill_response",
        session_id: "s-0",
        error: 'session_id "s-0" is not active',
      }),
    );

    // close MUST resolve even though the wire-side reply was an error.
    await expect(closeP).resolves.toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// data_frame fan-out is gated on session presence — late frames for a
// closed session are dropped silently rather than fanned out to a stale
// listener (mirrors `node-pty-host.ts`'s close-time subscription disposal).
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — data_frame fan-out gating", () => {
  it("does NOT call the data listener for a session that has been close()d", async () => {
    // Mirrors `node-pty-host.ts`'s close-time subscription disposal.
    // A DataFrame for a closed session is consumer-meaningless; drop
    // silently rather than fan out to a stale listener.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const dataFn = vi.fn();
    host.setOnData(dataFn);

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    // Close the session — sidecar-side will eventually deliver an
    // ExitCodeNotification but in the race window the daemon may
    // still receive late DataFrames.
    void host.close("s-0");
    await flushMicrotasks();
    // Deliver the kill_response so close's promise resolves cleanly.
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await flushMicrotasks();

    // Now deliver a late DataFrame for the closed session.
    const payload = Buffer.from("late chunk", "utf8").toString("base64");
    fake.writeStdout(
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: payload,
      }),
    );
    await flushMicrotasks();

    // The data listener MUST NOT fire for the closed session.
    expect(dataFn).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Dual error+exit events on the same child do not double-count the crash
// budget — Node's `child_process` can emit both signals for the same
// failed child (rare spawn-then-crash-mid-init edge case).
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — dual error+exit events do not double-charge the crash budget", () => {
  it("emits both 'error' and 'exit' for the same child; budget is consumed exactly once", async () => {
    // Node's `child_process` can in rare edge cases emit BOTH error
    // and exit for the same failed child (spawn synchronously OK,
    // then crash mid-init). Without the per-instance dedupe, each
    // handler calls crashBudget.recordAndIsExhausted() and the
    // budget exhausts at half the documented threshold. The
    // crashCountedChildren WeakSet guards against this.
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Spawn CRASH_BUDGET_LIMIT children. Each one emits BOTH error
    // and exit. Without the dedupe the budget exhausts after
    // CRASH_BUDGET_LIMIT / 2 children; with the dedupe the host
    // remains willing to respawn through CRASH_BUDGET_LIMIT - 1.
    for (let i = 0; i < CRASH_BUDGET_LIMIT - 1; i += 1) {
      clock.mockReturnValue(i * 1000);
      const reqP = host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      });
      await flushMicrotasks();
      // Emit both events — order matters less than the dedupe guard.
      seq.latest().triggerError(new Error("spawn-init crash"));
      seq.latest().triggerExit(1, null);
      await reqP.catch(() => undefined);
    }

    // Budget should NOT be exhausted yet — only CRASH_BUDGET_LIMIT-1
    // crashes have been counted (each child counted once).
    clock.mockReturnValue(CRASH_BUDGET_LIMIT * 1000);
    void host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    // The host accepted the spawn — budget had room.
    expect(seq.spawned().length).toBe(CRASH_BUDGET_LIMIT);
  });
});

// ----------------------------------------------------------------------------
// `resolveSidecarBinaryPath` — four-tier binary resolution per F-024-3-03.
//
// What we assert (T-024-3-3 acceptance criteria, dispatch §pin 5 ordering,
// dispatch §pin 4 four-exhausted enumeration):
//
//   * Tier 1 (env-var) hits → returns env value verbatim; tiers 2/3/4 NOT
//     consulted.
//   * Tier 1 relative-path → rejected (NOT coerced); tier 2 then consulted.
//   * Tier 2 (require.resolve) hits → returns resolved path; tiers 3/4 NOT
//     consulted.
//   * Tier 3 (release build) hits → returns release path; tier 4 NOT
//     consulted.
//   * Tier 4 (debug build) hits → returns debug path.
//   * All four exhausted → throws PtyBackendUnavailableError with
//     attemptedBackend='rust-sidecar' AND a message enumerating every tier
//     failure AND a `cause` carrying the tier-2 require.resolve error.
//   * Platform binary name: 'sidecar' on POSIX, 'sidecar.exe' on Windows.
// ----------------------------------------------------------------------------

describe("resolveSidecarBinaryPath — four-tier binary resolution (F-024-3-03)", () => {
  // Helper — build an injectable-deps record with the strict defaults each
  // test overrides. The defaults (empty env, throwing nodeRequire, false-
  // returning existsSync) ensure every test must opt-in to the tier it
  // wants to exercise.
  function makeOpts(over?: Partial<ResolveSidecarBinaryPathOptions>): {
    opts: ResolveSidecarBinaryPathOptions;
    requireMock: ReturnType<typeof vi.fn>;
    existsMock: ReturnType<typeof vi.fn>;
  } {
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("require.resolve: not configured (test default)");
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);
    const opts: ResolveSidecarBinaryPathOptions = {
      env: {},
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
      releasePath: "/fake/release/sidecar",
      debugPath: "/fake/debug/sidecar",
      platform: "linux",
      ...over,
    };
    return { opts, requireMock, existsMock };
  }

  it("tier 1 hits when AIS_PTY_SIDECAR_BIN is set to an absolute path (tiers 2/3/4 NOT consulted)", () => {
    const { opts, requireMock, existsMock } = makeOpts({
      env: { AIS_PTY_SIDECAR_BIN: "/abs/path/to/sidecar" },
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/abs/path/to/sidecar");
    // First-hit-wins — later tiers MUST NOT be consulted. Pin 5 ordering.
    expect(requireMock).not.toHaveBeenCalled();
    expect(existsMock).not.toHaveBeenCalled();
  });

  it("tier 1 rejects a relative path (NOT coerced to absolute) and falls through to tier 2", () => {
    // Per resolver rustdoc: relative paths couple to process.cwd() which
    // is caller-dependent. The resolver rejects-and-falls-through rather
    // than silently coerce. Tier 2 is then consulted.
    const tier2Mock = vi.fn<(id: string) => string>(() => "/from/tier-2/sidecar");
    const { opts } = makeOpts({
      env: { AIS_PTY_SIDECAR_BIN: "./relative/sidecar" },
      nodeRequire: { resolve: tier2Mock },
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/from/tier-2/sidecar");
    // Tier 2 was indeed consulted — proves tier 1 did NOT short-circuit
    // by returning the relative path verbatim.
    expect(tier2Mock).toHaveBeenCalledTimes(1);
  });

  it("tier 2 hits when require.resolve returns a path (tiers 3/4 NOT consulted)", () => {
    const requireMock = vi.fn<(id: string) => string>(() => "/installed/pkg/bin/sidecar");
    const { opts, existsMock } = makeOpts({
      nodeRequire: { resolve: requireMock },
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/installed/pkg/bin/sidecar");
    // The id passed to require.resolve must match F-024-3-03's format.
    expect(requireMock).toHaveBeenCalledTimes(1);
    expect(requireMock).toHaveBeenCalledWith(
      "@ai-sidekicks/pty-sidecar-linux-" + process.arch + "/bin/sidecar",
    );
    // Filesystem probes for tiers 3/4 MUST NOT have run.
    expect(existsMock).not.toHaveBeenCalled();
  });

  it("tier 3 hits when require.resolve throws but the release binary exists on disk (tier 4 NOT consulted)", () => {
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("Cannot find module '@ai-sidekicks/pty-sidecar-linux-x64'");
    });
    // Tier 3 returns true; tier 4 must NOT be probed.
    const existsMock = vi.fn<(p: string) => boolean>((p) => p === "/fake/release/sidecar");
    const { opts } = makeOpts({
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/fake/release/sidecar");
    // existsSync was called exactly once for the release path; the debug
    // path was NOT consulted (tier 4 short-circuited away).
    expect(existsMock).toHaveBeenCalledTimes(1);
    expect(existsMock).toHaveBeenCalledWith("/fake/release/sidecar");
  });

  it("tier 4 hits when only the debug binary exists on disk", () => {
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("Cannot find module");
    });
    const existsMock = vi.fn<(p: string) => boolean>((p) => p === "/fake/debug/sidecar");
    const { opts } = makeOpts({
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/fake/debug/sidecar");
    // Both tiers 3 and 4 were probed before tier 4 hit; debug was last.
    expect(existsMock).toHaveBeenCalledTimes(2);
    expect(existsMock).toHaveBeenNthCalledWith(1, "/fake/release/sidecar");
    expect(existsMock).toHaveBeenNthCalledWith(2, "/fake/debug/sidecar");
  });

  it("all four tiers exhausted → throws PtyBackendUnavailableError enumerating every tier failure", () => {
    // No env-var; require.resolve throws; existsSync returns false for
    // both release and debug. This is the canonical "fresh checkout, no
    // cargo build, no install" failure mode the resolver mitigates.
    const requireError = new Error("Cannot find module '@ai-sidekicks/pty-sidecar-linux-x64'");
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw requireError;
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);
    const { opts } = makeOpts({
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
    });

    let thrown: unknown = null;
    try {
      resolveSidecarBinaryPath(opts);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (!(thrown instanceof PtyBackendUnavailableError)) {
      return; // Type narrowing for the assertions below.
    }
    expect(thrown.code).toBe(PTY_BACKEND_UNAVAILABLE_CODE);
    expect(thrown.details.attemptedBackend).toBe("rust-sidecar");

    // Dispatch pin 4 — details.message enumerates every tier failure
    // (operator-grade diagnostic, not just "binary not found").
    expect(thrown.message).toMatch(/tier 1 \(env-var AIS_PTY_SIDECAR_BIN\): unset/);
    expect(thrown.message).toMatch(/tier 2 \(require\.resolve.*\): threw:/);
    expect(thrown.message).toMatch(
      /tier 3 \(packages\/sidecar-rust-pty\/target\/release\/sidecar\): not found at \/fake\/release\/sidecar/,
    );
    expect(thrown.message).toMatch(
      /tier 4 \(packages\/sidecar-rust-pty\/target\/debug\/sidecar\): not found at \/fake\/debug\/sidecar/,
    );

    // details.cause carries the tier-2 require.resolve error (closest
    // production-path miss; tier 1 is a developer-explicit override,
    // tiers 3/4 are workspace dev paths).
    expect(thrown.details.cause).toBe(requireError);
  });

  it("rejects-and-enumerates a relative-path tier-1 attempt when all four tiers miss", () => {
    // Strengthens the prior all-exhausted assertion — when tier 1 was
    // explicitly tried-and-rejected (relative path), the diagnostic
    // names the rejected value so the operator can see what they got
    // wrong.
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("not found");
    });
    const { opts } = makeOpts({
      env: { AIS_PTY_SIDECAR_BIN: "./relative/path" },
      nodeRequire: { resolve: requireMock },
    });

    let thrown: unknown = null;
    try {
      resolveSidecarBinaryPath(opts);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toMatch(
        /tier 1 \(env-var AIS_PTY_SIDECAR_BIN\): rejected \(relative path; absolute required\): "\.\/relative\/path"/,
      );
    }
  });

  it("on Windows, probes 'sidecar.exe' (not 'sidecar') for tier 2 and embeds .exe in tier 3/4 diagnostics", () => {
    // ADR-019 §Decision item 1 names Windows as the primary sidecar
    // target; the resolver MUST handle the .exe suffix or the
    // entire failure-mode mitigation regresses on the platform that
    // needs it most.
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("not found");
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);
    const { opts } = makeOpts({
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
      platform: "win32",
    });

    let thrown: unknown = null;
    try {
      resolveSidecarBinaryPath(opts);
    } catch (err) {
      thrown = err;
    }

    // Tier 2 was called with the .exe-suffixed binary name.
    expect(requireMock).toHaveBeenCalledWith(
      "@ai-sidekicks/pty-sidecar-win32-" + process.arch + "/bin/sidecar.exe",
    );
    // The tier-3 / tier-4 diagnostics also show the .exe suffix.
    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toMatch(
        /tier 3 \(packages\/sidecar-rust-pty\/target\/release\/sidecar\.exe\)/,
      );
      expect(thrown.message).toMatch(
        /tier 4 \(packages\/sidecar-rust-pty\/target\/debug\/sidecar\.exe\)/,
      );
    }
  });

  it("treats an empty-string AIS_PTY_SIDECAR_BIN identically to unset (falls through to tier 2)", () => {
    // Process-env values can be empty strings (e.g., `AIS_PTY_SIDECAR_BIN=`
    // in a shell). The resolver's `length === 0` guard handles this; an
    // empty-string env-var must NOT be returned as a valid binary path
    // (would cause an ENOENT downstream that surfaces as a less-actionable
    // error than "tier 1 unset").
    const requireMock = vi.fn<(id: string) => string>(() => "/installed/pkg/bin/sidecar");
    const { opts } = makeOpts({
      env: { AIS_PTY_SIDECAR_BIN: "" },
      nodeRequire: { resolve: requireMock },
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/installed/pkg/bin/sidecar");
    expect(requireMock).toHaveBeenCalledTimes(1);
  });

  it("tier 3/4 default paths land inside packages/sidecar-rust-pty/target/{release,debug}/ (pins workspaceTargetPath ascent depth)", () => {
    // The other resolver tests hardcode `releasePath` / `debugPath` via
    // `makeOpts`, which short-circuits the production-side
    // `workspaceTargetPath` ascent (the four-up
    // `../../../sidecar-rust-pty/target/...` off `import.meta.url`).
    // A regression that miscounts the depth (e.g., "fixes" the post-
    // build `dist/` resolution and changes `../../../` to `../../`)
    // would leave every other test green. This test calls the resolver
    // WITHOUT path overrides so the real ascent runs, and asserts via
    // existsSync invocation paths that the result lands inside the
    // correct workspace subtree.
    //
    // We assert on `path.sep`-suffixed substrings so the test passes
    // identically on POSIX (`/packages/sidecar-rust-pty/...`) and
    // Windows (`\packages\sidecar-rust-pty\...`) — `fileURLToPath`
    // returns a platform-native path separator.
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("Cannot find module (tier-2 forced miss)");
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);

    let thrown: unknown = null;
    try {
      // Note: NO `releasePath` / `debugPath` overrides — the resolver
      // computes both paths via `workspaceTargetPath`. We pin
      // `platform: "linux"` to keep the binary-name stable (no `.exe`
      // suffix complicating the substring assertions).
      resolveSidecarBinaryPath({
        env: {},
        nodeRequire: { resolve: requireMock },
        existsSync: existsMock,
        platform: "linux",
      });
    } catch (err) {
      thrown = err;
    }

    // Both tier 3 and tier 4 probe paths must land inside
    // `packages/sidecar-rust-pty/target/{release,debug}/sidecar` —
    // assert via the existsSync call arguments (the paths the resolver
    // tried to probe).
    expect(existsMock).toHaveBeenCalledTimes(2);
    const releaseProbe: string = existsMock.mock.calls[0]?.[0] ?? "";
    const debugProbe: string = existsMock.mock.calls[1]?.[0] ?? "";
    const releaseSuffix: string =
      pathSep + ["packages", "sidecar-rust-pty", "target", "release", "sidecar"].join(pathSep);
    const debugSuffix: string =
      pathSep + ["packages", "sidecar-rust-pty", "target", "debug", "sidecar"].join(pathSep);
    expect(releaseProbe.endsWith(releaseSuffix)).toBe(true);
    expect(debugProbe.endsWith(debugSuffix)).toBe(true);

    // Belt-and-suspenders — also pin the diagnostic message contents
    // so a future divergence between the probe path and the rendered
    // diagnostic is caught (the resolver embeds the resolved path in
    // the per-tier outcome string).
    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toContain(releaseSuffix);
      expect(thrown.message).toContain(debugSuffix);
    }
  });
});

// ----------------------------------------------------------------------------
// `RustSidecarPtyHost.ensureChild` — preserves resolver-thrown
// PtyBackendUnavailableError instead of wrapping it.
//
// The resolver emits a tier-enumerated `details.message` and a tier-2
// `details.cause` on the four-exhausted path. `ensureChild`'s catch must
// re-throw an instance of `PtyBackendUnavailableError` unchanged so the
// operator-grade diagnostic surfaces directly — without the guard, the
// original error would be buried two levels deep in `details.cause.message`
// and `details.cause.details.cause`. Mirrors the canonical guard pattern
// at `pty-host-selector.ts:251`.
//
// The existing test at the top of the file ("surfaces PtyBackendUnavailableError
// when resolveBinaryPath throws") only stubs the resolver to throw a plain
// `Error`, which exercises the WRAP branch — these tests cover the
// PASSTHROUGH branch.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — ensureChild preserves resolver-thrown PtyBackendUnavailableError", () => {
  it("re-throws the resolver's PtyBackendUnavailableError unchanged (same instance, original message intact)", async () => {
    // Build a resolver-thrown error with a recognizable tier-enumerated
    // shape. The supervisor's `ensureChild` MUST surface this instance
    // verbatim — not wrap it in a new error with the generic
    // "failed to resolve sidecar binary path" message.
    const innerCause: Error = new Error("Cannot find module '@ai-sidekicks/pty-sidecar-linux-x64'");
    const resolverError: PtyBackendUnavailableError = new PtyBackendUnavailableError(
      { attemptedBackend: "rust-sidecar", cause: innerCause },
      "RustSidecarPtyHost: sidecar binary not found on any of the four resolution tiers " +
        "(per Plan-024 §F-024-3-03). Attempts:\n" +
        "  tier 1 (env-var AIS_PTY_SIDECAR_BIN): unset\n" +
        "  tier 2 (require.resolve(...)): threw: Cannot find module\n" +
        "  tier 3 (...): not found at /workspace/.../release/sidecar\n" +
        "  tier 4 (...): not found at /workspace/.../debug/sidecar\n" +
        "Set AIS_PTY_SIDECAR_BIN=...",
    );

    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => {
        throw resolverError;
      },
      // Spawn should never be reached.
      spawn: vi.fn<SidecarSpawnFn>(),
    });

    let thrown: unknown = null;
    try {
      await host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      });
    } catch (err) {
      thrown = err;
    }

    // SAME-INSTANCE check — pins the passthrough contract. A regression
    // that wraps the inner error would fail `.toBe(resolverError)` even
    // if the wrapper carries the original as `details.cause`.
    expect(thrown).toBe(resolverError);
    // Belt-and-suspenders — assert the operator-grade message survives
    // verbatim. A future refactor that builds a NEW
    // `PtyBackendUnavailableError` carrying the same `details.cause`
    // would fail the same-instance check above but pass a generic
    // "x instanceof PtyBackendUnavailableError" — this assertion catches
    // that intermediate regression too.
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toContain("not found on any of the four resolution tiers");
      expect(thrown.message).toContain("tier 1 (env-var AIS_PTY_SIDECAR_BIN): unset");
      expect(thrown.details.cause).toBe(innerCause);
    }
  });

  it("still wraps a plain Error from a custom resolver (preserves prior wrap-branch behavior)", async () => {
    // The existing prior-PR test asserted this; we re-pin it here so a
    // future refactor that broadens the passthrough guard (e.g.,
    // `instanceof Error`) doesn't accidentally let plain errors through
    // without the `attemptedBackend: "rust-sidecar"` tag. Custom resolvers
    // that throw a plain `Error` still get the wrap.
    const cause: Error = new Error("custom resolver failure");
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => {
        throw cause;
      },
      spawn: vi.fn<SidecarSpawnFn>(),
    });

    let thrown: unknown = null;
    try {
      await host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: [],
        env: [],
        cwd: "/",
        rows: 24,
        cols: 80,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      // NOT the same instance — wrapped by ensureChild's wrap branch.
      expect(thrown).not.toBe(cause);
      expect(thrown.details.attemptedBackend).toBe("rust-sidecar");
      expect(thrown.details.cause).toBe(cause);
      expect(thrown.message).toBe("RustSidecarPtyHost: failed to resolve sidecar binary path");
    }
  });
});
