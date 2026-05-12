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
  MAX_HEADER_BYTES,
  PtyBackendUnavailableError,
  RustSidecarPtyHost,
  SidecarFrameDecodeError,
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
      expect(result.message).toMatch(/Content-Length value is not a strict non-negative integer/i);
    }
  });

  // Strict digit-only Content-Length grammar — pins the daemon-side
  // rejection surface. Phase 1 framing layer; below the I-024-N
  // invariants per Plan-024 §T-024-1-2 ("Verifies invariant: none —
  // framing layer below invariants").
  //
  // The daemon's `/^\d+$/` is DELIBERATELY STRICTER than the Rust
  // framer at packages/sidecar-rust-pty/src/framing.rs, which calls
  // `value.trim().parse::<usize>()`. Rust's `usize::from_str`
  // delegates to `from_str_radix(s, 10)`, whose grammar is
  // `^\+?[0-9]+$` — a leading `+` sign IS accepted for unsigned
  // types (only `-` is rejected). See
  // https://doc.rust-lang.org/std/primitive.usize.html#method.from_str_radix.
  //
  // The daemon side rejects `+N` to align with HTTP/1.1 RFC 7230
  // §3.3.2 (`Content-Length = 1*DIGIT` — no sign permitted;
  // https://datatracker.ietf.org/doc/html/rfc7230#section-3.3.2)
  // and as defense-in-depth at the daemon ↔ sidecar boundary. The
  // asymmetry is safe under the current trust architecture: a `+N`
  // frame dies at the daemon's boundary, the sidecar never sees it,
  // and the Rust sidecar never emits `+N` Content-Length values
  // (formats via `Display` on `usize`, which never produces `+`).
  //
  // The `Number.parseInt(value, 10)` shapes — `"12junk"`, `"12.5"` —
  // ARE genuine smuggling shapes the Rust side rejects and the prior
  // daemon code lax-accepted; tightening to `^\d+$` forecloses them
  // AND tightens the `+N` boundary beyond what Rust enforces.
  //
  // Both sides `.trim()` the value before the strict check, so
  // outer-whitespace cases (`" 12"`, `"12 "`) are ACCEPTANCE cases —
  // they normalize to `"12"` and pass the digit-only test.
  describe.each([
    ["empty string", ""],
    ["embedded letters", "12junk"],
    ["fractional", "12.0"],
    ["fractional with trailing zero", "12.5"],
    ["scientific notation", "12e1"],
    ["negative sign", "-12"],
    ["negative zero", "-0"],
    ["positive sign", "+12"],
    ["positive zero", "+0"],
    ["hex literal", "0x12"],
    ["hex prefix only", "0x"],
    ["whitespace-only value", "   "],
  ])("Content-Length strict-grammar rejection — %s (%j)", (_label, raw) => {
    it("rejects with the strict-grammar error and echoes the offending value JSON-encoded", () => {
      const parser = new ContentLengthParser();
      parser.feed(Buffer.from(`Content-Length: ${raw}\r\n\r\n`, "utf8"));
      const result = parser.nextFrame();
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.message).toMatch(
          /Content-Length value is not a strict non-negative integer/i,
        );
        // The offending value is echoed as a JSON string literal so a
        // peer cannot inject CRLF / control bytes into operator logs.
        // After the value-trim at line 725, embedded whitespace is
        // collapsed at the boundary; we assert the JSON-encoded
        // post-trim shape that actually fails the regex.
        expect(result.message).toContain(JSON.stringify(raw.trim()));
      }
    });
  });

  // Acceptance cases — pin the symmetric "is accepted" boundary so a
  // future tightening doesn't accidentally reject canonical shapes the
  // Rust side accepts (leading zeros + outer whitespace via trim).
  describe.each([
    ["zero", "0", 0],
    ["small positive", "123", 123],
    ["leading-zero canonical", "0123", 123],
    ["all zeros", "00000", 0],
    ["leading whitespace (trimmed)", " 12", 12],
    ["trailing whitespace (trimmed)", "12 ", 12],
    ["both-side whitespace (trimmed)", "  12  ", 12],
  ])("Content-Length strict-grammar acceptance — %s (%j → %d)", (_label, raw, expectedLen) => {
    it("accepts and decodes a body of the declared length", () => {
      const body = Buffer.alloc(expectedLen, 0x61); // 'a' * expectedLen
      const parser = new ContentLengthParser();
      parser.feed(Buffer.concat([Buffer.from(`Content-Length: ${raw}\r\n\r\n`, "utf8"), body]));
      const result = parser.nextFrame();
      expect(result.kind).toBe("frame");
      if (result.kind === "frame") {
        expect(result.body.length).toBe(expectedLen);
        expect(result.body.equals(body)).toBe(true);
      }
    });
  });

  it("preserves the duplicate-Content-Length defense ahead of the strict-grammar check", () => {
    // Regression guard: AC5 — the new validator MUST run AFTER the
    // duplicate-header check so the duplicate-shape error message is
    // surfaced even when the second value would also fail the
    // grammar. Without this ordering a peer could mask a smuggling
    // attempt as a "lax parser" complaint.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("Content-Length: 4\r\nContent-Length: 12junk\r\n\r\nbody", "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/duplicate Content-Length/i);
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

  // ----------------------------------------------------------------------------
  // Header-section MAX_HEADER_BYTES cap — defends the parser against
  // unbounded header buffering when a peer (or a desync condition) never
  // delivers `\r\n\r\n`. Without this cap, `feed()` would concatenate
  // forever. Mirrors the per-section cap in the IPC sibling framer at
  // `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` lines 274-288
  // (`if (buffer.byteLength > 1024) throw FramingError("header_too_long"…)`).
  // The Rust framer at `packages/sidecar-rust-pty/src/framing.rs:34`
  // enforces a 1 KiB PER-LINE cap by contrast — deliberately different
  // per the load-bearing comment at framing.rs:25-33. Phase 3 framer
  // hardening; below the I-024-N invariants per Plan-024 §T-024-3-1
  // ("framing layer below invariants").
  // ----------------------------------------------------------------------------

  it(`MAX_HEADER_BYTES is set to 1024 bytes (mirrors the TS IPC sibling per-section cap)`, () => {
    // Pin the constant value so a future divergence from the canonical
    // sibling pattern at local-ipc-gateway.ts:274-288 trips this test.
    expect(MAX_HEADER_BYTES).toBe(1024);
  });

  it("returns error when buffered bytes exceed MAX_HEADER_BYTES without CRLF CRLF terminator", () => {
    // Drive the worst case: a peer (or desync) starts spewing header
    // bytes that never terminate. The parser MUST stop accumulating
    // once the buffered prefix grows past MAX_HEADER_BYTES.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("X".repeat(MAX_HEADER_BYTES + 1), "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/header section exceeded 1024 bytes/);
      expect(result.message).toMatch(/framing desync/i);
    }
  });

  it("returns error when header section with delimiter exceeds MAX_HEADER_BYTES", () => {
    // Symmetric path: the delimiter IS present, but the header section
    // itself is oversized. Distinct diagnostic from the unterminated
    // case so the two failure modes are distinguishable in logs.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("X".repeat(2000) + "\r\n\r\n", "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/exceeds 1024 byte cap/);
      expect(result.message).toMatch(/with delimiter present/);
    }
  });

  it("returns incomplete when buffer is under MAX_HEADER_BYTES and no CRLF yet (happy-path regression)", () => {
    // Regression guard: the cap MUST NOT trip on a partial header that
    // is still within the cap. Otherwise valid frames split across two
    // feeds (the partial-read path) would be rejected.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("Content-Length: 5", "utf8")); // 17 bytes, well under cap
    const result = parser.nextFrame();
    expect(result.kind).toBe("incomplete");
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

  // Stale-stdout-listener regression: the stdout `data` listener was an
  // anonymous closure that was never removed when a child exited or
  // errored. After `handleChildExit` swaps in a fresh parser, late-
  // buffered bytes emitted on the OLD child's stdout would still arrive
  // at the (now-stale) listener and be fed into the NEW parser —
  // corrupting framing state. The fix tracks the listener reference per
  // child and detaches it during teardown before the parser swap.
  it("stale stdout from old child does NOT feed the fresh parser after handleChildExit", async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Bring up child A and complete one spawn round-trip.
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
    const childA = seq.latest();
    childA.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP1;

    // Trigger exit on child A. The fix detaches the stdout listener
    // before the parser swap; without it, the next stdout emission on
    // childA below would still feed into the supervisor's now-fresh
    // parser.
    clock.mockReturnValue(100);
    childA.triggerExit(0, null);
    await flushMicrotasks();

    // Emit LATE-buffered bytes on the OLD child's stdout. These would
    // have been a contamination vector under the bug. We deliberately
    // emit a payload that, if fed into the fresh parser, would
    // PARSE — a full frame whose body is a valid Envelope-shaped
    // JSON, so we can detect the contamination via
    // `handleInbound` running for the stale frame on the supervisor
    // side. The supervisor would either log a spurious "unmatched
    // frame" warning OR (worse) attempt to resolve an outstanding
    // request with stale data.
    //
    // To detect cleanly: queue an outstanding `spawn` request on the
    // (next) child and observe whether it is resolved by the stale
    // bytes OR by the fresh bytes we send through the new child.
    clock.mockReturnValue(150);
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

    // Send a STALE response on the OLD child's stdout — with the
    // session id "s-STALE-OLD-CHILD". If the listener were still
    // attached, this would feed the fresh parser, produce a complete
    // `spawn_response` frame, and resolve `spawnP2` with the stale
    // session id.
    childA.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-STALE-OLD-CHILD" }));
    await flushMicrotasks();

    // Send the legitimate response on the NEW child's stdout.
    seq
      .latest()
      .writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-FRESH-NEW-CHILD" }));
    const response2 = await spawnP2;

    // The fresh response wins. If `s-STALE-OLD-CHILD` arrives instead,
    // it proves the old listener is still wired through and the bug
    // has regressed.
    expect(response2).toEqual({
      kind: "spawn_response",
      session_id: "s-FRESH-NEW-CHILD",
    });
  });

  // Same axis as above for the `error` event handler. `handleChildError`
  // shares the parser-reset + listener-detach contract with
  // `handleChildExit`; this test mirrors the structure so both teardown
  // paths are pinned against the stale-stdout-listener regression.
  it("stale stdout from old child does NOT feed the fresh parser after handleChildError", async () => {
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
    const childA = seq.latest();
    childA.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP1;

    // Async error path instead of exit.
    clock.mockReturnValue(100);
    childA.triggerError(new Error("ENOENT: async spawn failure"));
    await flushMicrotasks();

    // Queue a fresh request that the next child will need to serve.
    clock.mockReturnValue(150);
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

    // Stale frame on the OLD child's stdout post-error.
    childA.writeStdout(
      frameEnvelope({
        kind: "spawn_response",
        session_id: "s-STALE-FROM-ERRORED-CHILD",
      }),
    );
    await flushMicrotasks();

    // Fresh frame on the NEW child.
    seq.latest().writeStdout(
      frameEnvelope({
        kind: "spawn_response",
        session_id: "s-FRESH-AFTER-ERROR",
      }),
    );
    const response2 = await spawnP2;

    expect(response2).toEqual({
      kind: "spawn_response",
      session_id: "s-FRESH-AFTER-ERROR",
    });
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

  it("rejects host.spawn() when the sidecar emits SpawnResponse{ error: ... } (instead of hanging)", async () => {
    // Symmetric extension of the kill/write/resize error path. Prior
    // to the SpawnResponse contract bump, a sidecar `spawn` failure
    // (e.g., `command: "/nonexistent-binary"` against an alive,
    // healthy sidecar) logged to stderr and DROPPED the request, so
    // the daemon's awaiting Promise hung indefinitely (the
    // supervisor's `sendRequest` has no per-request timeout — only
    // sync-throw on stdin.write or eventual rejection on child-exit).
    // The wire-side typed error path converts the otherwise-
    // indefinite hang into a prompt rejection. The
    // `await expect(...).rejects.toThrow(...)` assertion shape is
    // load-bearing under vitest's default 5s timeout: a regression
    // that reintroduces the hang would NOT surface as a passing test
    // — vitest would fail the test with an explicit "exceeded timeout"
    // diagnostic rather than silently passing.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnPromise = host.spawn({
      kind: "spawn_request",
      command: "/nonexistent-binary",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    // Sidecar emits the typed error envelope (the post-fix wire shape):
    // session_id: "" because no session was minted on the failure path;
    // error carries the portable-pty diagnostic.
    fake.writeStdout(
      frameEnvelope({
        kind: "spawn_response",
        session_id: "",
        error: "portable-pty error: No such file or directory (os error 2)",
      }),
    );

    await expect(spawnPromise).rejects.toThrow(
      /sidecar spawn_response returned error.*portable-pty/,
    );
  });

  it("does NOT register session tracking when host.spawn() rejects via SpawnResponse error", async () => {
    // Pins the supervisor invariant from `protocol::SpawnResponse`
    // rustdoc: on the failure path session_id is empty, so the
    // supervisor MUST NOT register tracking on it. After the
    // rejection, a subsequent kill/resize/write on the empty session
    // id MUST throw the synchronous `unknown sessionId ''` error
    // (proving the session table never grew).
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnPromise = host.spawn({
      kind: "spawn_request",
      command: "/nonexistent-binary",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(
      frameEnvelope({
        kind: "spawn_response",
        session_id: "",
        error: "portable-pty error: No such file or directory (os error 2)",
      }),
    );
    await expect(spawnPromise).rejects.toThrow();

    // Session table MUST NOT contain the empty id — a resize on '' is
    // the truly-unknown-sessionId throw shape from the supervisor.
    await expect(host.resize("", 30, 100)).rejects.toThrow(/unknown sessionId ''/);
  });

  it("does NOT register a session when SpawnResponse carries error (non-empty session_id)", async () => {
    // Symmetric guard with the empty-session_id test above, but pinning
    // the error-discrimination branch in `resolveOutstanding`: even
    // when the sidecar emits a non-empty session_id alongside an
    // `error` field, the daemon's rejection path MUST `return` BEFORE
    // reaching the in-band registration site. Otherwise a sidecar bug
    // (or contract drift) could mint a session_id on a failed spawn
    // and leave the daemon tracking a session the sidecar never
    // materialized. Post-rejection, a write to the would-be id MUST
    // throw the synchronous `unknown sessionId` error (proving the
    // session table never grew).
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnPromise = host.spawn({
      kind: "spawn_request",
      command: "/nonexistent-binary",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(
      frameEnvelope({
        kind: "spawn_response",
        session_id: "s-failed",
        error: "portable-pty error: command not found",
      }),
    );
    await expect(spawnPromise).rejects.toThrow(/portable-pty error: command not found/);

    // Post-rejection: a write to s-failed must reject (unknown session) —
    // the error-branch s-failed id must NOT have been registered.
    await expect(host.write("s-failed", new Uint8Array([0]))).rejects.toThrow(
      /unknown sessionId 's-failed'/,
    );
  });

  it("emits exactly one frame on the spawn-failure round-trip (the SpawnRequest only)", async () => {
    // Pins the wire shape: the supervisor emits exactly one frame
    // per spawn (the SpawnRequest), and the rejection arrives
    // entirely via the inbound SpawnResponse — no second outbound
    // frame is sent. Without this, a future regression that retried
    // the spawn (or sent a follow-up close/kill) would silently
    // change the wire shape.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnPromise = host.spawn({
      kind: "spawn_request",
      command: "/nonexistent-binary",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    fake.writeStdout(
      frameEnvelope({
        kind: "spawn_response",
        session_id: "",
        error: "portable-pty error: No such file or directory (os error 2)",
      }),
    );
    await expect(spawnPromise).rejects.toThrow();

    // Exactly one outbound envelope — the SpawnRequest itself.
    const envelopes = parseFramesFromStdin(fake.readStdin());
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      kind: "spawn_request",
      command: "/nonexistent-binary",
    });
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

  it("close() suppresses subsequent onExit on late ExitCodeNotification (substitutability with NodePtyHost)", async () => {
    // The race pinned here: the consumer calls close(sessionId), which
    // dispatches a kill_request{SIGTERM} and removes the session record
    // synchronously. The sidecar's `ExitCodeNotification` for the same
    // session_id arrives later on the wire via the inbound dispatch
    // loop. A late onExit fan-out after close() breaks substitutability
    // with `NodePtyHost`, which disposes its `child.onExit` subscription
    // BEFORE the kill dispatch (see node-pty-host.ts:619-626) AND gates
    // its Windows synthetic onExit on `this.sessions.has(sessionId)`
    // (see 640-644). Consumers treat close() as terminal; a duplicate
    // teardown event after close() is a contract regression. The fix
    // (handleExitNotification unknown-session branch) suppresses the
    // late fan-out and logs diagnostically instead.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const exitFn = vi.fn();
    host.setOnExit(exitFn);

    // Bring a session up.
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

    // close() dispatches a kill_request{SIGTERM} and awaits the response.
    // Resolve the kill_response from the mock so close() returns; the
    // session record is removed synchronously after.
    const closeP = host.close("s-0");
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(closeP).resolves.toBeUndefined();

    // Sanity guard: no onExit fired during the close() round-trip
    // itself — the late notification, not the close path, is the
    // surface we're pinning.
    expect(exitFn).not.toHaveBeenCalled();

    // Now the sidecar's late ExitCodeNotification arrives — this is
    // the wire-arrival the bug surfaces on. Under the bug, the
    // unknown-session branch fired fireExit and the spy would record
    // one call with the late exit code; with the fix it MUST be
    // suppressed.
    fake.writeStdout(
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 137,
        signal_code: 9,
      }),
    );
    await flushMicrotasks();

    expect(exitFn).not.toHaveBeenCalled();
  });

  it("close() suppresses onExit when ExitCodeNotification arrives BEFORE kill_response (inverse wire order)", async () => {
    // The KillResponse wire-protocol rustdoc explicitly documents that
    // `exit_code_notification` CAN arrive before `kill_response` on the
    // wire. This test pins the inverse of the kill-first case: the
    // sidecar's exit notification lands WHILE close() is still awaiting
    // the kill_response. Because close() deletes the session record
    // synchronously before dispatching the kill_request, the late
    // notification falls into the unknown-session branch and is
    // suppressed (same as the kill-first ordering). Without the
    // delete-before-await ordering the known-session branch would fire
    // onExit mid-close, breaking the post-close() onExit-suppression
    // contract.
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

    // Start close() but do NOT yet write the kill_response. close()
    // synchronously removes the session record from `this.sessions`,
    // then awaits the wire-side kill_response.
    const closeP = host.close("s-0");
    await flushMicrotasks();

    // Inverse-order arrival: the late ExitCodeNotification lands FIRST
    // while close() is still pending. Under the bug (sessions.delete
    // after await) this fell into the known-session branch and fired
    // onExit; with the fix it falls into the unknown-session branch
    // and is suppressed.
    fake.writeStdout(
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 137,
        signal_code: 9,
      }),
    );
    await flushMicrotasks();

    // No onExit fired yet — close() has not resolved.
    expect(exitFn).not.toHaveBeenCalled();

    // Now resolve the kill_response so close() returns.
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(closeP).resolves.toBeUndefined();

    // Final assertion: no onExit fired across the entire round-trip.
    expect(exitFn).not.toHaveBeenCalled();
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
// Same-stdout-chunk frame coalescing — SpawnResponse + trailing
// DataFrame / ExitCodeNotification frames delivered in one kernel pipe-
// read chunk MUST observe sessions.has(session_id) === true when the
// drain loop dispatches them, because the sidecar's spawn_reader_task
// and spawn_waiter_task are spawned BEFORE the dispatcher queues
// SpawnResponse and merge_to_writer's unbiased `tokio::select!` can
// pick outbound_tx first. The fix is in `resolveOutstanding`: register
// the session synchronously on spawn_response success, before
// `head.resolve(envelope)` queues the awaiter's microtask. Without
// this, the drain loop would dispatch trailing frames for a freshly-
// minted session_id with sessions.has(id) === false and silently drop
// them. (Plan-024 §T-024-3-1; ADR-019 §Failure Mode Analysis.)
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — same-stdout-chunk frame coalescing (Plan-024 §T-024-3-1)", () => {
  it("delivers DataFrame arriving same-chunk after SpawnResponse to onData", async () => {
    // Setup: fake child, host attached, register onData listener BEFORE
    // spawn. The race targets: the sidecar writer queues SpawnResponse
    // and DataFrame on separate channels; merge_to_writer's unbiased
    // select! can pick outbound first; even when SpawnResponse wins the
    // writer race, the kernel pipe-read can deliver both frames in one
    // chunk. The daemon's drain loop MUST dispatch DataFrame with
    // sessions.has(id) === true (i.e., registration synchronous on
    // spawn_response receipt, not post-await in spawn()).
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const dataChunks: Uint8Array[] = [];
    host.setOnData((sessionId, bytes) => {
      if (sessionId === "s-0") {
        dataChunks.push(bytes);
      }
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/echo",
      args: ["hi"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    // Emit BOTH frames in one writeStdout to simulate kernel-pipe
    // coalescing — the parser.feed receives them as one Buffer and the
    // drain loop processes both synchronously without yielding.
    const both = Buffer.concat([
      frameEnvelope({ kind: "spawn_response", session_id: "s-0" }),
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: Buffer.from("hi\n", "utf8").toString("base64"),
      }),
    ]);
    fake.writeStdout(both);
    const response = await spawnP;
    expect(response).toEqual({ kind: "spawn_response", session_id: "s-0" });
    expect(dataChunks).toHaveLength(1);
    expect(Buffer.from(dataChunks[0]!).toString("utf8")).toBe("hi\n");
  });

  it("delivers ExitCodeNotification arriving same-chunk after SpawnResponse to onExit", async () => {
    // Symmetric scenario for the short-lived-process case where the
    // sidecar's spawn_waiter_task emits ExitCodeNotification on
    // outbound_tx before merge_to_writer drains dispatch_tx's
    // SpawnResponse. Even when SpawnResponse wins the writer race the
    // kernel pipe-read can deliver both frames in one chunk; the
    // daemon must register the session on spawn_response receipt so
    // handleExitNotification observes the session as known.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const exits: Array<{ sessionId: string; exitCode: number; signalCode: number | undefined }> =
      [];
    host.setOnExit((sessionId, exitCode, signalCode) => {
      if (sessionId === "s-0") {
        exits.push({ sessionId, exitCode, signalCode });
      }
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/echo",
      args: ["hi"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    const both = Buffer.concat([
      frameEnvelope({ kind: "spawn_response", session_id: "s-0" }),
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
    ]);
    fake.writeStdout(both);
    const response = await spawnP;
    expect(response).toEqual({ kind: "spawn_response", session_id: "s-0" });
    expect(exits).toEqual([{ sessionId: "s-0", exitCode: 0, signalCode: undefined }]);
  });

  it("delivers same-chunk DataFrame + ExitCodeNotification trailing SpawnResponse for short-lived process", async () => {
    // The full short-lived-process scenario: the sidecar's
    // spawn_reader_task drains the PTY's output and spawn_waiter_task
    // observes the child exit, both queued on outbound_tx BEFORE the
    // dispatcher queues SpawnResponse on dispatch_tx. The kernel pipe-
    // read can return all three frames in a single chunk; the daemon's
    // drain loop processes them synchronously and the trailing two
    // must observe sessions.has(id) === true.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const dataChunks: Uint8Array[] = [];
    const exits: Array<{ sessionId: string; exitCode: number }> = [];
    host.setOnData((sessionId, bytes) => {
      if (sessionId === "s-0") {
        dataChunks.push(bytes);
      }
    });
    host.setOnExit((sessionId, exitCode) => {
      if (sessionId === "s-0") {
        exits.push({ sessionId, exitCode });
      }
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/echo",
      args: ["hi"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    const allThree = Buffer.concat([
      frameEnvelope({ kind: "spawn_response", session_id: "s-0" }),
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: Buffer.from("hi\n", "utf8").toString("base64"),
      }),
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
    ]);
    fake.writeStdout(allThree);
    await spawnP;
    expect(dataChunks).toHaveLength(1);
    expect(Buffer.from(dataChunks[0]!).toString("utf8")).toBe("hi\n");
    expect(exits).toEqual([{ sessionId: "s-0", exitCode: 0 }]);
  });
});

// ----------------------------------------------------------------------------
// Pre-spawn event buffering — `DataFrame` / `ExitCodeNotification` arriving
// on the wire BEFORE the matching `SpawnResponse` for a freshly-spawned
// session.
//
// The sidecar's `spawn_reader_task` and `spawn_waiter_task` are spawned
// (per `packages/sidecar-rust-pty/src/pty_session.rs::spawn()`) BEFORE
// the dispatcher queues `SpawnResponse` on `dispatch_tx`. The merger at
// `packages/sidecar-rust-pty/src/main.rs::merge_to_writer` selects
// unbiased between `dispatch_tx` and `outbound_tx`, so for a sub-
// millisecond-lived child the waiter's exit notification can land on
// the wire BEFORE the dispatcher's spawn response. The daemon-side
// `RustSidecarPtyHost` MUST:
//
//   1. Buffer the pre-spawn events keyed by `session_id` (the fifth-
//      pass fix only covered events trailing `SpawnResponse` in the
//      same I/O chunk; the symmetric pre-spawn ordering needs its own
//      buffer).
//   2. Replay the buffer after registering the session via
//      `SpawnResponse` handling.
//   3. Defer the replay to a separate I/O turn (`setImmediate`) so the
//      consumer's `await spawn()` continuation runs BEFORE the buffered
//      listener fan-out fires — otherwise `onData(id, ...)` / `onExit(
//      id, ...)` would fire before the consumer records `id` in its
//      own state, breaking substitutability with `NodePtyHost` (which
//      cannot have this race — `pty.spawn()` is synchronous and the
//      `child.onExit` subscription is wired atomically inside spawn()).
//
// (Plan-024 §T-024-3-1 + §I-024-6; ADR-019 §Failure Mode Analysis.)
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — pre-spawn event buffering (Plan-024 §I-024-6)", () => {
  /**
   * Yield to the I/O loop's Check phase so any `setImmediate` callbacks
   * scheduled during prior microtask + I/O work get a chance to run.
   * Used as the deterministic "drain the replay's setImmediate" barrier
   * after `await spawnP` resolves.
   */
  async function flushSetImmediate(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  it("PE1 — delivers DataFrame arriving same-chunk BEFORE SpawnResponse, after spawn() resolves", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const events: Array<{ tag: "data" | "spawn-resolved"; text?: string }> = [];
    host.setOnData((sessionId, bytes) => {
      if (sessionId === "s-0") {
        events.push({ tag: "data", text: Buffer.from(bytes).toString("utf8") });
      }
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/echo",
      args: ["hi"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    // Wire order: DataFrame FIRST, then SpawnResponse. Mirrors the
    // sidecar's merge_to_writer race where outbound_tx (DataFrame) is
    // selected ahead of dispatch_tx (SpawnResponse).
    const dataBeforeSpawn = Buffer.concat([
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: Buffer.from("hi\n", "utf8").toString("base64"),
      }),
      frameEnvelope({ kind: "spawn_response", session_id: "s-0" }),
    ]);
    fake.writeStdout(dataBeforeSpawn);

    const response = await spawnP;
    events.push({ tag: "spawn-resolved" });
    expect(response).toEqual({ kind: "spawn_response", session_id: "s-0" });

    // Drain the setImmediate-deferred replay.
    await flushSetImmediate();

    // Assertion: onData fires AFTER spawn() resolves (the buffered
    // chunk is not lost; the consumer observes spawn-resolved BEFORE
    // the data fan-out fires).
    expect(events.map((e) => e.tag)).toEqual(["spawn-resolved", "data"]);
    expect(events[1]).toMatchObject({ tag: "data", text: "hi\n" });
  });

  it("PE2 — delivers ExitCodeNotification arriving same-chunk BEFORE SpawnResponse, after spawn() resolves", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const events: Array<{ tag: "exit" | "spawn-resolved"; exitCode?: number }> = [];
    host.setOnExit((sessionId, exitCode) => {
      if (sessionId === "s-0") {
        events.push({ tag: "exit", exitCode });
      }
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/true",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    // Wire order: ExitCodeNotification FIRST (sub-ms-exit child where
    // waiter_task wins the unbiased select), then SpawnResponse.
    const exitBeforeSpawn = Buffer.concat([
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
      frameEnvelope({ kind: "spawn_response", session_id: "s-0" }),
    ]);
    fake.writeStdout(exitBeforeSpawn);

    const response = await spawnP;
    events.push({ tag: "spawn-resolved" });
    expect(response).toEqual({ kind: "spawn_response", session_id: "s-0" });

    await flushSetImmediate();

    expect(events.map((e) => e.tag)).toEqual(["spawn-resolved", "exit"]);
    expect(events[1]).toMatchObject({ tag: "exit", exitCode: 0 });
  });

  it("PE3 — preserves wire order for DataFrame + ExitCodeNotification preceding SpawnResponse; both fire after spawn() resolves", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const events: Array<{
      tag: "data" | "exit" | "spawn-resolved";
      text?: string;
      exitCode?: number;
    }> = [];
    host.setOnData((sessionId, bytes) => {
      if (sessionId === "s-0") {
        events.push({ tag: "data", text: Buffer.from(bytes).toString("utf8") });
      }
    });
    host.setOnExit((sessionId, exitCode) => {
      if (sessionId === "s-0") {
        events.push({ tag: "exit", exitCode });
      }
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/echo",
      args: ["hi"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    // Wire order: DataFrame → ExitCodeNotification → SpawnResponse.
    // The pre-spawn buffer MUST preserve arrival order (data first,
    // then exit) and the replay MUST fire both AFTER spawn() resolves.
    const allThree = Buffer.concat([
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: Buffer.from("hi\n", "utf8").toString("base64"),
      }),
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
      frameEnvelope({ kind: "spawn_response", session_id: "s-0" }),
    ]);
    fake.writeStdout(allThree);

    await spawnP;
    events.push({ tag: "spawn-resolved" });

    await flushSetImmediate();

    expect(events.map((e) => e.tag)).toEqual(["spawn-resolved", "data", "exit"]);
    expect(events[1]).toMatchObject({ tag: "data", text: "hi\n" });
    expect(events[2]).toMatchObject({ tag: "exit", exitCode: 0 });
  });

  it("PE4 — survives drain-cycle boundary: DataFrame in chunk N, SpawnResponse in chunk N+1, replay still fires", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const events: Array<{ tag: "data" | "spawn-resolved"; text?: string }> = [];
    host.setOnData((sessionId, bytes) => {
      if (sessionId === "s-0") {
        events.push({ tag: "data", text: Buffer.from(bytes).toString("utf8") });
      }
    });

    const spawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/echo",
      args: ["hi"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();

    // Chunk 1: DataFrame alone — daemon's drain loop buffers it under
    // the pre-spawn-buffer branch.
    fake.writeStdout(
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: Buffer.from("hi\n", "utf8").toString("base64"),
      }),
    );
    // Give the drain loop a turn so the DataFrame settles into the
    // pre-spawn buffer before SpawnResponse arrives in chunk 2.
    await flushMicrotasks();

    // Chunk 2: SpawnResponse alone — daemon registers the session and
    // schedules a setImmediate replay of the buffered DataFrame.
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));

    await spawnP;
    events.push({ tag: "spawn-resolved" });

    await flushSetImmediate();

    expect(events.map((e) => e.tag)).toEqual(["spawn-resolved", "data"]);
    expect(events[1]).toMatchObject({ tag: "data", text: "hi\n" });
  });

  it("PE5 — pre-spawn buffer cleared on supervisor teardown so pre-respawn events do not replay against fresh post-respawn session", async () => {
    // The sidecar's session_id counter (`s-{n}`) resets on respawn.
    // Without buffer-clear-on-teardown, a pre-respawn DataFrame for
    // `s-0` that never received its SpawnResponse (because the
    // sidecar crashed before emitting it) would sit in the
    // pre-spawn buffer indefinitely — and the post-respawn fresh
    // child's SpawnResponse for `s-0` (a different logical session
    // but the same wire id) would replay the stale pre-respawn
    // DataFrame against the new session. Verify the buffer is
    // cleared on `handleChildExit` so only the new child's data
    // reaches `onData`.
    const seq = spawnReturningSequence();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
    });

    const observed: string[] = [];
    host.setOnData((sessionId, bytes) => {
      if (sessionId === "s-0") {
        observed.push(Buffer.from(bytes).toString("utf8"));
      }
    });

    // First spawn — pre-crash. Daemon issues spawn_request; we never
    // deliver SpawnResponse. Instead the child emits a DataFrame for
    // `s-0` (pre-spawn-buffer entry) and then crashes.
    const preCrashSpawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/echo",
      args: ["stale"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    seq.latest().writeStdout(
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: Buffer.from("STALE\n", "utf8").toString("base64"),
      }),
    );
    await flushMicrotasks();
    // Crash the first child — handleChildExit clears the pre-spawn
    // buffer per I-024-6.
    seq.latest().triggerExit(1, null);
    await preCrashSpawnP.catch(() => undefined);

    // Post-respawn — issue a fresh spawn. Daemon respawns and the
    // new child emits SpawnResponse(s-0) followed by a fresh
    // DataFrame.
    const postCrashSpawnP = host.spawn({
      kind: "spawn_request",
      command: "/bin/echo",
      args: ["fresh"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    const newChild = seq.latest();
    newChild.writeStdout(
      Buffer.concat([
        frameEnvelope({ kind: "spawn_response", session_id: "s-0" }),
        frameEnvelope({
          kind: "data_frame",
          session_id: "s-0",
          stream: "stdout",
          seq: 0,
          bytes: Buffer.from("FRESH\n", "utf8").toString("base64"),
        }),
      ]),
    );
    await postCrashSpawnP;
    await flushSetImmediate();

    // The stale pre-crash DataFrame MUST NOT have replayed — only the
    // post-respawn fresh DataFrame should reach the consumer.
    expect(observed).toEqual(["FRESH\n"]);
  });

  it("PE5b — closed-session-id retention cleared on supervisor teardown so post-respawn fresh session is not suppressed", async () => {
    // Symmetric to PE5: if `closedSessionIds` retained pre-respawn
    // ids across supervisor teardown, a fresh post-respawn session
    // reusing an id that the pre-crash supervisor had `close()`d
    // would have its DataFrame / ExitCodeNotification suppressed
    // (instead of delivered via the alive-session branch). Verify
    // closedSessionIds is cleared by `clearPreSpawnState` on
    // `handleChildExit` per I-024-6.
    const seq = spawnReturningSequence();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
    });

    const observed: string[] = [];
    host.setOnData((sessionId, bytes) => {
      if (sessionId === "s-0") {
        observed.push(Buffer.from(bytes).toString("utf8"));
      }
    });

    // Pre-crash: spawn → SpawnResponse → close() (records s-0 in
    // closedSessionIds).
    const preP = host.spawn({
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
    await preP;
    const closeP = host.close("s-0");
    await flushMicrotasks();
    seq.latest().writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await closeP;

    // Crash the first child — handleChildExit clears
    // closedSessionIds per I-024-6 so the post-respawn fresh `s-0`
    // is not suppressed.
    seq.latest().triggerExit(1, null);

    // Post-respawn: fresh spawn for s-0 (same wire id, new logical
    // session). Emit SpawnResponse + DataFrame.
    const postP = host.spawn({
      kind: "spawn_request",
      command: "/bin/echo",
      args: ["fresh"],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await flushMicrotasks();
    const newChild = seq.latest();
    newChild.writeStdout(
      Buffer.concat([
        frameEnvelope({ kind: "spawn_response", session_id: "s-0" }),
        frameEnvelope({
          kind: "data_frame",
          session_id: "s-0",
          stream: "stdout",
          seq: 0,
          bytes: Buffer.from("FRESH\n", "utf8").toString("base64"),
        }),
      ]),
    );
    await postP;
    await flushSetImmediate();

    // The fresh DataFrame MUST reach the consumer — closedSessionIds
    // was cleared on teardown so the post-respawn `s-0` is treated
    // as alive, not suppressed.
    expect(observed).toEqual(["FRESH\n"]);
  });

  it("PE6 — late ExitCodeNotification arriving after close() is suppressed (not buffered)", async () => {
    // Regression guard on the close()-aware suppression branch: a
    // session that was alive then closed MUST suppress a late
    // ExitCodeNotification (the post-close() onExit-suppression
    // contract clause). Without `closedSessionIds`, the unknown-
    // session branch could mis-route the late notification into the
    // pre-spawn buffer — where it would leak until supervisor
    // teardown — instead of being suppressed.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const exits: number[] = [];
    host.setOnExit((sessionId, exitCode) => {
      if (sessionId === "s-0") {
        exits.push(exitCode);
      }
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

    // Close before the child exits — synchronous delete from sessions
    // map + record in closedSessionIds.
    const closeP = host.close("s-0");
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await closeP;

    // Late ExitCodeNotification — must be suppressed per the
    // post-close() onExit-suppression contract.
    fake.writeStdout(
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
    );
    await flushMicrotasks();
    await flushSetImmediate();

    expect(exits).toEqual([]);
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
// Stale-event guard on handleChildExit / handleChildError.
//
// Node's `child_process` can emit BOTH `exit` and `error` for a single
// spawn-then-crash-mid-init failure. The supervisor's `exit` / `error`
// listeners are attached per-child in `attachChildListeners` and closed
// over the child reference at attach time. After the first event runs the
// canonical teardown chain (`this.child = null`) and `ensureChild()`
// spawns a replacement, a LATE second event for the OLD child must NOT
// mutate the new child's global state.
//
// Without the `if (this.child !== child) return` guard, the second event
// would (a) wipe the new child via `this.child = null`, (b) detach a
// stdout listener against the wrong stream, (c) reject every pending
// outstanding request that was queued for the NEW child with an error
// attributing the failure to the OLD child's exit/error.
//
// The pre-existing `crashCountedChildren` WeakSet (exercised in the
// previous describe block) deduped BUDGET CONSUMPTION only — the
// cleanup steps ran unconditionally above it. This is the gap closed
// here.
//
// Refs: Local class invariant — see RustSidecarPtyHost class rustdoc
// and handleChildExit rustdoc for the active-child-only teardown
// contract. Plan-024 §T-024-3-1 governs the broader crash-respawn
// supervision.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — stale child lifecycle events do not clobber the replacement child", () => {
  it("stale 'exit' event for an old child after replacement does not clear the new child", async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Spawn child A and complete a round-trip so A is fully active.
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
    const childA = seq.latest();
    childA.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP1;

    // Fire A's `exit` event. The supervisor runs the canonical
    // teardown (parser reset → `this.child = null` → reject outstanding
    // → record crash) on the active-child path because `this.child ===
    // childA` at this point.
    clock.mockReturnValue(100);
    childA.triggerExit(1, null);
    await flushMicrotasks();

    // Issue a fresh request — forces `ensureChild()` to spawn child B.
    // We capture B (NOT via `seq.latest()` later — that helper returns
    // the most-recently-spawned fake, which is what we want here but
    // we MUST also keep the `childA` reference captured above for the
    // stale fire below).
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
    const childB = seq.latest();

    // Now fire a SECOND `exit` event for the OLD child A — the
    // captured reference, NOT via `seq.latest()` (which is B). This
    // simulates Node's rare `exit`-then-`exit` (or `error`-then-`exit`)
    // pair where the second event arrives after `ensureChild()` has
    // already spawned the replacement. Without the stale-event guard
    // this would wipe `this.child = null` (clobbering B), detach a
    // listener against A's stdout (no-op against B but the code path
    // is still wrong), and reject B's pending `spawnP2` with a
    // misleading "sidecar exited" error.
    childA.triggerExit(1, null);
    await flushMicrotasks();

    // Assert (i): `this.child` still points at B (the replacement),
    // NOT cleared back to null by the stale event. Cast through
    // index-access because `child` is a private field.
    const hostInternals: { child: SidecarChildProcess | null } = host as unknown as {
      child: SidecarChildProcess | null;
    };
    expect(hostInternals.child).toBe(childB.child);

    // Assert (ii): the pending `spawnP2` request — issued AFTER A's
    // first exit but BEFORE the stale second exit — resolves via B's
    // response, NOT rejected by the stale event's `rejectAllOutstanding`
    // path. Deliver B's response now to drive `spawnP2` to resolution.
    childB.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    await expect(spawnP2).resolves.toEqual({ kind: "spawn_response", session_id: "s-1" });
  });

  it("stale 'error' event for an old child after replacement does not clear the new child", async () => {
    // Mirrors the `exit`-event scenario above for the `error` listener.
    // `handleChildError` shares the stale-event guard contract with
    // `handleChildExit`; this test pins it for the async-error path.
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
    const childA = seq.latest();
    childA.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP1;

    // First event tears down A on the active-child path.
    clock.mockReturnValue(100);
    childA.triggerError(new Error("first error event"));
    await flushMicrotasks();

    // Force a replacement spawn.
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
    const childB = seq.latest();

    // Stale second `error` for the OLD child A. Without the guard,
    // this would clobber B and reject `spawnP2`.
    childA.triggerError(new Error("late stale error event"));
    await flushMicrotasks();

    // (i) `this.child` still points at B.
    const hostInternals: { child: SidecarChildProcess | null } = host as unknown as {
      child: SidecarChildProcess | null;
    };
    expect(hostInternals.child).toBe(childB.child);

    // (ii) `spawnP2` resolves via B's response — the stale error did
    // not reject it.
    childB.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    await expect(spawnP2).resolves.toEqual({ kind: "spawn_response", session_id: "s-1" });
  });

  it("error after exit on the same child runs teardown only once (regression preservation)", async () => {
    // Regression preservation: the previous describe block's
    // `crashCountedChildren` WeakSet still pins single-source crash
    // budget consumption when both `error` and `exit` fire for the
    // same child. With the new stale-event guard, the second event
    // now early-returns BEFORE reaching `recordCrashOncePerChild` —
    // budget is consumed exactly once, but via a different mechanism
    // (the guard, not the WeakSet). Test that the observable behavior
    // (no double-charge, child reference cleared exactly once) is
    // preserved.
    //
    // This complements (does not replace) the previous block's
    // "emits both error and exit ... budget consumed exactly once"
    // test, which drives the same axis across multiple children to
    // exhaust-but-not-overrun the budget.
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
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
    const childA = seq.latest();

    // Fire BOTH events for the same child (no replacement spawned
    // in between). First event takes the active-child path; second
    // hits the stale-event guard because `this.child === null !==
    // childA` after the first teardown.
    clock.mockReturnValue(50);
    childA.triggerExit(1, null);
    await flushMicrotasks();
    childA.triggerError(new Error("late error after exit"));
    await flushMicrotasks();

    // The first `exit` rejected `spawnP` via the canonical teardown.
    await expect(spawnP).rejects.toThrow(/sidecar exited/);

    // Now force a respawn — the second (stale) event must NOT have
    // permanently latched the supervisor (no double-budget-charge),
    // so the next request still spawns a fresh child.
    clock.mockReturnValue(150);
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
    await expect(spawnP2).resolves.toEqual({ kind: "spawn_response", session_id: "s-1" });
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

// ----------------------------------------------------------------------------
// ensureChild — concurrent cold-start callers serialize on a single spawn
// (Plan-024, T-024-3-1).
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — ensureChild concurrent-spawn serialization", () => {
  it("serializes N parallel cold-start callers onto a single spawnFn invocation", async () => {
    // Race shape: with a cold host, several PtyHost methods called in
    // parallel (e.g., concurrent `spawn` requests, or `write` racing
    // `kill`) each await `ensureChild`. Before the fix, each caller
    // could pass the `this.child === null` check, yield on
    // `resolveSpawn()`, and reach `spawnFn(...)` — orphaning all but
    // the last-assigned child. The Promise-memoized in-flight spawn
    // collapses all callers onto one attempt.
    const fake = makeFakeChild();
    const spawnFn = vi
      .fn<SidecarSpawnFn>()
      .mockImplementation(() => fake.child as unknown as ReturnType<SidecarSpawnFn>);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnFn,
    });

    // Fire 5 parallel spawn requests against the cold host. Each will
    // call `ensureChild`; without the serialization fix, the spawn
    // stub would be invoked once per caller.
    const requests: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5; i += 1) {
      requests.push(
        host.spawn({
          kind: "spawn_request",
          command: "/bin/sh",
          args: [],
          env: [],
          cwd: "/",
          rows: 24,
          cols: 80,
        }),
      );
    }
    await flushMicrotasks();

    // The sidecar receives 5 framed SpawnRequests on the SAME stdin —
    // one child, five session ids. Deliver matching SpawnResponses.
    for (let i = 0; i < 5; i += 1) {
      fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: `s-${i}` }));
    }
    const responses = await Promise.all(requests);

    // Load-bearing assertion: spawnFn called exactly once across the 5
    // concurrent cold-start callers. The pre-fix shape would record
    // up to 5 invocations (one per caller that passed the null check).
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Every caller receives a valid SpawnResponse — none rejected
    // because their child got orphaned by a later-assigned one.
    expect(responses).toHaveLength(5);
    for (const response of responses) {
      expect(response).toMatchObject({ kind: "spawn_response" });
    }

    // Post-call sanity: the single live child accepts further wire
    // traffic. Issuing a `write` against one of the returned session
    // ids should frame onto the SAME stdin we just observed receiving
    // the spawn requests. A pre-fix orphaned-child shape would route
    // the write to a different stdin (or none, if the orphan's
    // listeners were never wired against `this.child`).
    const stdinBefore = fake.readStdin().length;
    const writeP = host.write("s-0", new Uint8Array([0x61])); // "a"
    await flushMicrotasks();
    expect(fake.readStdin().length).toBeGreaterThan(stdinBefore);
    fake.writeStdout(frameEnvelope({ kind: "write_response", session_id: "s-0" }));
    await expect(writeP).resolves.toBeUndefined();
  });

  it("clears the in-flight latch on failure so the next call retries (crash budget consumed once)", async () => {
    // After a failed cold-start, `this.inflightSpawn` MUST be cleared
    // so the next caller can re-enter `ensureChild` and trigger a
    // fresh spawn attempt. A latch that stuck on the rejected promise
    // would either re-throw the cached failure (a stuck host) or
    // double-charge the crash budget (a leaked retry). Neither is
    // correct: the budget is the load-bearing failure-rate gate; the
    // in-flight latch is purely for concurrent-caller deduplication.
    let attempt = 0;
    const fake = makeFakeChild();
    const spawnFn = vi.fn<SidecarSpawnFn>().mockImplementation(() => {
      attempt += 1;
      if (attempt === 1) {
        const e = new Error("ENOENT") as Error & { code?: string };
        e.code = "ENOENT";
        throw e;
      }
      return fake.child as unknown as ReturnType<SidecarSpawnFn>;
    });
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnFn,
      nowMs: clock,
    });

    // First spawn fails synchronously (ENOENT) — the supervisor wraps
    // it in PtyBackendUnavailableError and consumes ONE budget slot.
    let firstThrown: unknown = null;
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
      firstThrown = err;
    }
    expect(firstThrown).toBeInstanceOf(PtyBackendUnavailableError);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Second spawn — the in-flight latch MUST be cleared, allowing a
    // fresh attempt. The stub returns the fake child on attempt 2.
    // A stale `inflightSpawn` pointing at the rejected promise from
    // attempt 1 would short-circuit this call into the cached
    // failure, never invoking spawnFn a second time.
    clock.mockReturnValue(1000);
    const secondP = host.spawn({
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
    const response = await secondP;
    expect(response).toEqual({ kind: "spawn_response", session_id: "s-0" });
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Crash budget consumed exactly once across the failure + retry.
    // We verify indirectly via the sliding-window arithmetic: with
    // ONE slot consumed so far, the host should tolerate
    // `CRASH_BUDGET_LIMIT - 1` more synchronous failures before
    // surfacing the budget-exhausted message. If the in-flight latch
    // had double-charged the budget on the first failure, the host
    // would surface budget-exhausted one cycle early.
    //
    // The live sidecar from attempt 2 must exit first so the next
    // request triggers a fresh spawn rather than reusing the child.
    // That exit is itself a crash event — so it consumes one
    // additional slot, bringing the total used to 2.
    fake.triggerExit(1, null);
    await flushMicrotasks();

    // Re-arm the stub to throw ENOENT for the remaining attempts so
    // every subsequent request consumes a synchronous-failure slot.
    spawnFn.mockImplementation(() => {
      const e = new Error("ENOENT") as Error & { code?: string };
      e.code = "ENOENT";
      throw e;
    });

    // Slots used so far: 1 (first synchronous ENOENT) + 1 (sidecar
    // exit) = 2. Drive `CRASH_BUDGET_LIMIT - 2` more synchronous
    // failures so the cumulative count reaches CRASH_BUDGET_LIMIT —
    // the LAST one exhausts the budget. A double-charge regression
    // on the first failure would have used 2 slots there, putting
    // the cumulative at 3 by this point, and the exhaustion would
    // hit on the (CRASH_BUDGET_LIMIT - 3)th iteration instead.
    for (let i = 0; i < CRASH_BUDGET_LIMIT - 2; i += 1) {
      clock.mockReturnValue(2000 + i * 1000);
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
      // None of these should yet be the budget-exhausted message —
      // they should all be the per-spawn ENOENT wrap. The budget
      // exhausts on the LAST iteration (cumulative == LIMIT), and
      // the message-shape transition only kicks in on the NEXT call
      // after that.
      if (caught instanceof PtyBackendUnavailableError) {
        expect(caught.message).not.toMatch(/crash-respawn budget exhausted/);
      }
    }

    // The next request after the budget is exhausted MUST surface
    // the budget-exhausted message specifically. A double-charge
    // regression would have triggered this one cycle earlier.
    clock.mockReturnValue(2000 + CRASH_BUDGET_LIMIT * 1000);
    let exhaustedThrown: unknown = null;
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
      exhaustedThrown = err;
    }
    expect(exhaustedThrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (exhaustedThrown instanceof PtyBackendUnavailableError) {
      expect(exhaustedThrown.message).toMatch(/crash-respawn budget exhausted/);
    }
  });
});

// ----------------------------------------------------------------------------
// Pipe-error listeners on stdin / stdout / stderr (Plan-024, T-024-3-1).
//
// Async pipe errors (ERR_STREAM_DESTROYED, EPIPE, EIO) on the sidecar
// child's three stream objects fire as `'error'` events — they bypass
// any synchronous try/catch wrapping the `child.stdin.write(...)` call.
// Without per-pipe listeners these escalate to `uncaughtException` and
// crash the daemon. The supervisor attaches a handler on each of
// stdin/stdout/stderr that (a) consumes the event so Node does not
// escalate, (b) SIGTERMs the child so the existing `handleChildExit`
// path runs `rejectAllOutstanding(...)` — that's the load-bearing
// cleanup. The `child.on('error', ...)` listener attached in
// `attachChildListeners` catches errors on the child PROCESS, NOT
// pipe-level errors on the stream objects.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — pipe error handlers (Plan-024, T-024-3-1)", () => {
  // Symmetry-cover stdin/stdout/stderr through a single test definition:
  // the production handler is a shared factory across all three streams,
  // so the assertion shape is identical and a regression that fixes
  // only one stream would leave the others as latent crash sources.
  // `it.each` keeps the assertion shape as a single source of truth.
  it.each([
    { which: "stdin" as const, errMsg: "write EPIPE" },
    { which: "stdout" as const, errMsg: "read EIO" },
    { which: "stderr" as const, errMsg: "read EIO" },
  ])(
    "consumes async error on child.$which and triggers SIGTERM-driven cleanup without escalating to uncaughtException",
    async ({ which, errMsg }) => {
      // Capture `uncaughtException` BEFORE the test body so we can
      // prove the production code is consuming the error event.
      // Without this capture, Node's uncaughtException would fire
      // AFTER the test body completes — the test process exits cleanly
      // and we miss the regression even when the listener is absent.
      // This assertion is the load-bearing one; vitest also installs
      // its own handler, but that behavior can be configured away.
      const uncaught: Error[] = [];
      const captureUncaught = (err: Error): void => {
        uncaught.push(err);
      };
      process.on("uncaughtException", captureUncaught);

      try {
        const fake = makeFakeChild();
        const host = new RustSidecarPtyHost({
          resolveBinaryPath: () => "/fake/sidecar",
          spawn: spawnReturning(fake),
        });

        // Start a spawn() request — enqueues an outstanding entry and
        // wires the stream listeners via attachChildListeners.
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

        // Emit the async pipe error on the target stream. Without the
        // production-side listener this would escalate to
        // `uncaughtException`.
        fake.child[which].emit("error", new Error(errMsg));

        // Simulate the child exit that follows the SIGTERM the handler
        // dispatched; handleChildExit drains outstanding via
        // rejectAllOutstanding(...).
        fake.triggerExit(null, "SIGTERM");

        // Outstanding request rejects (not a hang).
        await expect(spawnP).rejects.toThrow(/sidecar exited/);

        // No uncaughtException escalated — production listener
        // consumed the error event.
        expect(uncaught).toHaveLength(0);

        // SIGTERM was dispatched, triggering the existing exit-driven
        // cleanup path.
        const killMock = fake.child.kill as ReturnType<typeof vi.fn>;
        expect(killMock).toHaveBeenCalledWith("SIGTERM");
      } finally {
        process.off("uncaughtException", captureUncaught);
      }
    },
  );
});

// ----------------------------------------------------------------------------
// Payload-layer corruption is a fatal supervisor event identical in shape to
// the framing-error path (Plan-024 §T-024-3-1 crash-respawn supervision;
// ADR-019 §Failure Mode Analysis sidecar-originated failure → fallback
// chain; local PtyHost contract substitutability lives in
// packages/contracts/src/pty-host.ts).
//
// Three distinct decode-failure shapes converge on the same teardown chain:
//
//   (a) `{garbage`         — JSON.parse throws (token-level malformed).
//                            decodeCause = "json-parse".
//   (b) `null`             — JSON.parse succeeds but the value is not an
//                            object envelope (downstream `.kind` access
//                            would TypeError on null without the guard).
//                            decodeCause = "non-object-envelope".
//       `[1,2,3]`          — JSON.parse succeeds and yields an array;
//                            `typeof [] === "object"` and `[] !== null`
//                            so the typeof+null check alone misses it.
//                            Arrays have no `.kind`, so without the
//                            `Array.isArray` guard the switch falls
//                            through silently and outstanding promises
//                            hang. Same failure mode as `null`,
//                            different bypass. decodeCause = "non-object-
//                            envelope".
//   (c) `{"kind":"future"}`— JSON.parse succeeds and yields a non-array
//                            object whose `kind` discriminator does NOT
//                            match any compile-time `Envelope` variant
//                            (version skew between daemon and sidecar,
//                            or a sidecar bug). The dispatch switch's
//                            new `default:` arm intercepts so the
//                            teardown shape is symmetric with (a)/(b);
//                            without it, every queued outstanding
//                            Promise would hang indefinitely.
//                            decodeCause = "unknown-kind". Compile-time
//                            exhaustiveness is preserved via the
//                            `_exhaustive: never` assignment after the
//                            named cases — adding a new `Envelope`
//                            variant without a corresponding `case` arm
//                            fails typecheck even though the runtime
//                            arm exists.
// ----------------------------------------------------------------------------

/**
 * Encode a raw string body as a Content-Length frame so the test can
 * deliver payloads that `frameEnvelope` (which `JSON.stringify`s a typed
 * Envelope) cannot produce — specifically `{garbage` (not valid JSON),
 * `null` (valid JSON, not an object), and `[1,2,3]` (valid JSON, valid
 * object-ish-by-typeof but array-shaped).
 */
function frameRawBody(rawBody: string): Buffer {
  const payload: Buffer = Buffer.from(rawBody, "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

describe("RustSidecarPtyHost — fatal teardown on JSON-decode failure", () => {
  it("(a) malformed JSON body `{garbage` SIGKILLs the child, rejects every outstanding pending-Promise with SidecarFrameDecodeError(cause='json-parse'), and records the crash exactly once", async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Spawn s-0 and complete the round-trip so the host has a session.
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

    // Issue two outstanding requests of distinct kinds so the test
    // verifies "every outstanding pending-Promise across every response
    // kind" — not just the head of a single FIFO. Both queue without
    // a sidecar response.
    const resizeP = host.resize("s-0", 30, 100);
    const writeP = host.write("s-0", new Uint8Array([0x68, 0x69])); // "hi"
    await flushMicrotasks();

    // Deliver a frame body that is well-formed at the wire level but
    // whose payload is not valid JSON.
    seq.latest().writeStdout(frameRawBody("{garbage"));
    await flushMicrotasks();

    // (i) child is killed via SIGKILL — mirrors the framing-error path.
    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    // Drive the exit event so the supervisor consumes the budget and
    // runs the canonical teardown chain.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    // (ii) every queued request promise rejects with the typed error
    // explaining the JSON-decode failure (NOT the generic "sidecar
    // exited" message that would surface if the stash threading is
    // broken).
    await expect(resizeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(resizeP).rejects.toThrow(/failed to parse inbound JSON envelope/);
    await expect(writeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(writeP).rejects.toThrow(/failed to parse inbound JSON envelope/);

    // Cause-kind assertion — both rejections carry decodeCause='json-parse'.
    // The upstream `expect(...).toBeInstanceOf(...)` is load-bearing: if it
    // failed, the inner `if (instanceof)` narrowing would skip the
    // `decodeCause` check silently (Vitest continues past failed
    // assertions). Keep both.
    const resizeErr: unknown = await resizeP.catch((e: unknown) => e);
    const writeErr: unknown = await writeP.catch((e: unknown) => e);
    expect(resizeErr).toBeInstanceOf(SidecarFrameDecodeError);
    if (resizeErr instanceof SidecarFrameDecodeError) {
      expect(resizeErr.decodeCause).toBe("json-parse");
    }
    expect(writeErr).toBeInstanceOf(SidecarFrameDecodeError);
    if (writeErr instanceof SidecarFrameDecodeError) {
      expect(writeErr.decodeCause).toBe("json-parse");
    }

    // (iii) handleChildExit downstream — the supervisor respawns
    // cleanly on the next request (no permanent unavailability after
    // a single crash).
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
    await expect(spawnP2).resolves.toEqual({ kind: "spawn_response", session_id: "s-1" });
  });

  it("(a) crash budget records the JSON-decode failure exactly once per child (no double-count when the SIGKILL ack drives a second event)", async () => {
    // Drive 5 JSON-decode failures back-to-back; each respawn should
    // consume one slot of CRASH_BUDGET_LIMIT. The 5th exhausts the
    // budget and the next request surfaces PtyBackendUnavailableError.
    // If the JSON-decode path were double-counting (e.g., counting the
    // failure synchronously inside handleInbound AND again in the
    // exit handler), the budget would exhaust at the 3rd failure, not
    // the 5th. This locks in single-source crash accounting.
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    for (let i = 0; i < CRASH_BUDGET_LIMIT; i++) {
      clock.mockReturnValue(i * 100);
      // Each crash needs a request in flight; otherwise ensureChild
      // wouldn't spawn a fresh child. A spawn is fine — the malformed
      // JSON drops in before the sidecar gets to ack.
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
      seq.latest().writeStdout(frameRawBody("{garbage"));
      await flushMicrotasks();
      seq.latest().triggerExit(137, "SIGKILL");
      await flushMicrotasks();
      await expect(spawnP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    }

    // Budget exhausted — the next spawn surfaces PtyBackendUnavailable.
    clock.mockReturnValue(CRASH_BUDGET_LIMIT * 100);
    const spawnExhausted = host.spawn({
      kind: "spawn_request",
      command: "/bin/sh",
      args: [],
      env: [],
      cwd: "/",
      rows: 24,
      cols: 80,
    });
    await expect(spawnExhausted).rejects.toBeInstanceOf(PtyBackendUnavailableError);
    await expect(spawnExhausted).rejects.toMatchObject({ code: PTY_BACKEND_UNAVAILABLE_CODE });
  });

  it("(b) JSON-valid but non-object payload (`null`) SIGKILLs the child and rejects outstanding with SidecarFrameDecodeError(cause='non-object-envelope')", async () => {
    // `JSON.parse("null")` returns `null` — it does NOT throw. The
    // post-parse type guard intercepts so the teardown shape is
    // identical to the parse-throw case; without it the downstream
    // `null.kind` access would TypeError out of handleInbound and
    // bubble silently to the stdout listener.
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

    const resizeP = host.resize("s-0", 30, 100);
    await flushMicrotasks();

    seq.latest().writeStdout(frameRawBody("null"));
    await flushMicrotasks();

    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    await expect(resizeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(resizeP).rejects.toThrow(/decoded payload is not an object envelope/);
    await expect(resizeP).rejects.toThrow(/observedKind=null/);

    const resizeErr: unknown = await resizeP.catch((e: unknown) => e);
    expect(resizeErr).toBeInstanceOf(SidecarFrameDecodeError);
    if (resizeErr instanceof SidecarFrameDecodeError) {
      expect(resizeErr.decodeCause).toBe("non-object-envelope");
    }
  });

  it("(b) JSON-valid but array payload (`[1,2,3]`) SIGKILLs the child and rejects outstanding with SidecarFrameDecodeError(cause='non-object-envelope')", async () => {
    // Array bypass of the non-object guard. `typeof [] === "object"`
    // is `true` and `[] !== null`, so the original `typeof !== "object"
    // || === null` check did NOT trip on arrays — JSON.parse would
    // happily yield `[1,2,3]`, the downstream `envelope.kind` read
    // would return `undefined`, no `case` arm of the switch would
    // match, `handleInbound` would return silently, and outstanding
    // promises would hang. Distinguished from `(c) unknown_kind` by
    // structure: arrays cannot syntactically satisfy the `Envelope`
    // discriminated-union (no string-typed `.kind`), so this is a
    // JSON-decode failure mode, not an unknown-variant mode.
    //
    // Test message asserts `observedKind=array` so a future reader
    // scanning failures can distinguish array bypass from null bypass
    // without re-running the test.
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

    const writeP = host.write("s-0", new Uint8Array([0x68, 0x69])); // "hi"
    await flushMicrotasks();

    seq.latest().writeStdout(frameRawBody("[1,2,3]"));
    await flushMicrotasks();

    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    await expect(writeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(writeP).rejects.toThrow(/decoded payload is not an object envelope/);
    await expect(writeP).rejects.toThrow(/observedKind=array/);

    const writeErr: unknown = await writeP.catch((e: unknown) => e);
    expect(writeErr).toBeInstanceOf(SidecarFrameDecodeError);
    if (writeErr instanceof SidecarFrameDecodeError) {
      expect(writeErr.decodeCause).toBe("non-object-envelope");
    }
  });

  it("multiple decode failures in the same drain pass (back-to-back framed bodies) do not double-kill the child", async () => {
    // Defends the `pendingTeardownCause !== null` early-return in
    // failFatallyOnDecodeError. If two malformed frames land in a
    // single chunk (the parser's drain loop processes them in order),
    // the first triggers the kill + stash; the second must see the
    // stash and skip the kill. Without the guard the second `child.kill`
    // would fire on the same (already-killed) child — best-effort
    // tolerates it, but the code-shape is the regression target.
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

    // Two malformed frames in a single write — the parser's drain
    // loop processes both before yielding.
    const twoBad: Buffer = Buffer.concat([frameRawBody("{garbage"), frameRawBody("null")]);
    seq.latest().writeStdout(twoBad);
    await flushMicrotasks();

    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    // Exactly one SIGKILL — the second decode-failure short-circuits
    // on `pendingTeardownCause !== null`.
    const sigkillCalls = killMock.mock.calls.filter(
      (call: readonly unknown[]) => call[0] === "SIGKILL",
    );
    expect(sigkillCalls.length).toBe(1);
  });

  it("(c) unknown envelope kind triggers fatal teardown with decodeCause='unknown-kind'", async () => {
    // A sidecar version skew or sidecar bug can emit a frame whose
    // `kind` discriminator does not match any compile-time `Envelope`
    // variant. JSON.parse succeeds, the non-object-envelope guards
    // pass (it IS an object), but no `case` arm matches. The new
    // `default:` arm in `handleInbound`'s switch intercepts so the
    // teardown shape is symmetric with (a)/(b); without it, every
    // queued outstanding Promise would hang indefinitely.
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

    // Queue an outstanding request that the unknown-kind teardown
    // must reject with the typed error.
    const resizeP = host.resize("s-0", 30, 100);
    await flushMicrotasks();

    // Deliver a frame whose JSON body is well-formed-as-object but
    // carries a `kind` value the daemon's compile-time `Envelope`
    // union does not know.
    seq.latest().writeStdout(
      frameRawBody(
        JSON.stringify({
          kind: "future_unknown_kind",
          session_id: "s-0",
          seq: 1,
        }),
      ),
    );
    await flushMicrotasks();

    // (i) child is killed via SIGKILL — symmetric with the json-parse
    // and non-object-envelope paths above.
    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    // Drive the exit event so the supervisor consumes the budget and
    // runs the canonical teardown chain.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    // (ii) the queued resize rejects with the typed error carrying
    // decodeCause='unknown-kind' and a diagnostic naming the offending
    // discriminator.
    await expect(resizeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(resizeP).rejects.toThrow(/unknown inbound envelope kind "future_unknown_kind"/);

    const resizeErr: unknown = await resizeP.catch((e: unknown) => e);
    expect(resizeErr).toBeInstanceOf(SidecarFrameDecodeError);
    if (resizeErr instanceof SidecarFrameDecodeError) {
      expect(resizeErr.decodeCause).toBe("unknown-kind");
    }
  });

  it("(c) unknown envelope kind with non-string kind field still triggers fatal teardown", async () => {
    // Defends against the diagnostic-string degenerate case: a sidecar
    // bug might emit a frame whose body is `{"kind": 42}` (numeric)
    // or `{"kind": null}` (null). The body still satisfies the
    // non-object-envelope guard (it IS an object), and no case arm of
    // the switch matches a non-string kind, so the new `default:` arm
    // intercepts. The diagnostic message uses the
    // `<non-string:${typeof}>` substitute so the operator-grade error
    // log still names a usable observed type without coercing the
    // raw value into a stringified form.
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

    const writeP = host.write("s-0", new Uint8Array([0x68, 0x69])); // "hi"
    await flushMicrotasks();

    seq.latest().writeStdout(frameRawBody('{"kind":42}'));
    await flushMicrotasks();

    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    // Diagnostic includes `<non-string:number>` so a future reader
    // scanning logs can distinguish a non-string-kind sidecar bug
    // from a normal version-skew unknown-string-kind.
    await expect(writeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(writeP).rejects.toThrow(/<non-string:number>/);

    const writeErr: unknown = await writeP.catch((e: unknown) => e);
    expect(writeErr).toBeInstanceOf(SidecarFrameDecodeError);
    if (writeErr instanceof SidecarFrameDecodeError) {
      expect(writeErr.decodeCause).toBe("unknown-kind");
    }
  });
});

// ----------------------------------------------------------------------------
// Fatal teardown on `data_frame.bytes` that is not strict RFC 4648 §4 base64.
//
// `Buffer.from(s, "base64")` is permissive — it silently drops characters
// outside the canonical alphabet and tolerates misaligned padding. Without
// strict validation the malformed payload would otherwise be delivered as
// a corrupted byte stream to consumer `onData` callbacks with no decode-
// error signal, breaking the wire contract silently. Symmetric in shape
// with the json-parse / non-object-envelope / unknown-kind paths above:
//
//   (d) `bytes` contains an out-of-alphabet character (e.g., `"AAA@"`,
//       which passes length-mod-4 but fails the regex). Pins the
//       alphabet-check branch of `isStrictBase64`.
//   (d) `bytes` length is not a multiple of 4 (e.g., `"abc"`, which
//       fails the length check before the regex even runs). Pins the
//       length-check branch of `isStrictBase64`.
//
// Both routes through `failFatallyOnDecodeError` with decodeCause =
// "invalid-base64". `onData` MUST NOT fire — verified via a registered
// spy that the test asserts was NEVER called.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — fatal teardown on data_frame base64 decode failure", () => {
  it("(d) data_frame.bytes with invalid-alphabet character SIGKILLs the child, does NOT fire onData, and rejects outstanding with SidecarFrameDecodeError(cause='invalid-base64')", async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Register an onData spy BEFORE the data_frame lands so the
    // assertion that the spy was NEVER called is meaningful.
    const onDataSpy = vi.fn();
    host.setOnData(onDataSpy);

    // Spawn s-0 and complete the round-trip so the host has a session
    // registered. The base64-validation runs BEFORE all three routing
    // branches (alive, closed, unknown) — exercising the alive branch
    // is the strictest test because the alive path is the one that
    // would dispatch to onData if validation were absent.
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

    // Queue an outstanding request so the teardown rejection has
    // something concrete to assert against.
    const resizeP = host.resize("s-0", 30, 100);
    await flushMicrotasks();

    // Deliver a data_frame whose `bytes` field passes the length-mod-4
    // check (4 chars) but contains an out-of-alphabet character (`@`).
    // This pins the alphabet-check branch of `isStrictBase64`.
    seq.latest().writeStdout(
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: "AAA@",
      }),
    );
    await flushMicrotasks();

    // (i) child is killed via SIGKILL — symmetric with the json-parse,
    // non-object-envelope, and unknown-kind paths above.
    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    // (ii) onData spy was NEVER invoked — the corrupted payload was
    // intercepted before reaching the dispatch branches. This is the
    // load-bearing assertion: without strict validation, `Buffer.from(
    // "AAA@", "base64")` would silently drop the `@` and deliver the
    // corrupted decoded prefix to the consumer.
    expect(onDataSpy).not.toHaveBeenCalled();

    // Drive the exit event so the supervisor consumes the budget and
    // runs the canonical teardown chain.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    // (iii) outstanding promise rejects with the typed decode error
    // carrying decodeCause='invalid-base64'.
    await expect(resizeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(resizeP).rejects.toThrow(/data_frame\.bytes is not strict base64/);
    await expect(resizeP).rejects.toThrow(/session=s-0/);

    const resizeErr: unknown = await resizeP.catch((e: unknown) => e);
    expect(resizeErr).toBeInstanceOf(SidecarFrameDecodeError);
    if (resizeErr instanceof SidecarFrameDecodeError) {
      expect(resizeErr.decodeCause).toBe("invalid-base64");
    }
  });

  it("(d) data_frame.bytes with bad padding (length not multiple of 4) SIGKILLs the child, does NOT fire onData, and rejects outstanding with SidecarFrameDecodeError(cause='invalid-base64')", async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    const onDataSpy = vi.fn();
    host.setOnData(onDataSpy);

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

    // Queue an outstanding write so the teardown rejection has
    // a concrete promise to assert against.
    const writeP = host.write("s-0", new Uint8Array([0x68, 0x69])); // "hi"
    await flushMicrotasks();

    // Deliver a data_frame whose `bytes` length is 3 — fails the
    // length-mod-4 check before the regex even runs. This pins the
    // length-check branch of `isStrictBase64` (distinct from the
    // alphabet-check branch covered by the prior test).
    seq.latest().writeStdout(
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: "abc",
      }),
    );
    await flushMicrotasks();

    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    // Load-bearing: onData spy was NEVER invoked. `Buffer.from("abc",
    // "base64")` would silently produce a 2-byte buffer (treating
    // "abc" as if it were "abcA" with implicit pad) without strict
    // validation — corrupting the consumer's byte stream invisibly.
    expect(onDataSpy).not.toHaveBeenCalled();

    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    await expect(writeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(writeP).rejects.toThrow(/data_frame\.bytes is not strict base64/);
    await expect(writeP).rejects.toThrow(/length=3/);

    const writeErr: unknown = await writeP.catch((e: unknown) => e);
    expect(writeErr).toBeInstanceOf(SidecarFrameDecodeError);
    if (writeErr instanceof SidecarFrameDecodeError) {
      expect(writeErr.decodeCause).toBe("invalid-base64");
    }
  });
});
