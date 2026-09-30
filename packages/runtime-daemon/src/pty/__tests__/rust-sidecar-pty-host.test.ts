// Tests for `RustSidecarPtyHost`, the daemon-side supervisor of the Rust PTY sidecar.
//
// The supervisor's `spawn` dependency is replaced by a fake child whose stdin, stdout and stderr
// are `PassThrough` streams and whose `exit` and `error` events come from an `EventEmitter`, so
// framing, crash-respawn and teardown run end to end without a real binary. Crash-budget tests
// inject a mock clock so the 60-second sliding window is deterministic.

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
 * Fake child process: tests read what the supervisor wrote to `stdin`, feed `stdout`, and fire
 * `exit` and `error` through `triggerExit` and `triggerError`.
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

  const stdinChunks: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => {
    stdinChunks.push(chunk);
  });

  // Overloads are needed because the `exit` and `error` listeners have different signatures;
  // one permissive implementation defers to the EventEmitter.
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
 * Stub `SidecarSpawnFn` that always returns `fake`. The cast is safe because the supervisor
 * uses only the `SidecarChildProcess` subset.
 */
function spawnReturning(fake: FakeChild): SidecarSpawnFn {
  return vi
    .fn<SidecarSpawnFn>()
    .mockImplementation(() => fake.child as unknown as ReturnType<SidecarSpawnFn>);
}

/**
 * Stub `SidecarSpawnFn` that returns a fresh fake on each call, for crash-respawn tests;
 * `latest` returns the most recently spawned fake.
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

/** Encode an envelope as a Content-Length frame, as the sidecar writes it to stdout. */
function frameEnvelope(envelope: Envelope): Buffer {
  const payload: Buffer = Buffer.from(JSON.stringify(envelope), "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

/** Decode the Content-Length frames the supervisor wrote to stdin into envelopes. */
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
 * Yield to the microtask queue twice so PassThrough `data` dispatch and the promise chain settle
 * before assertions run.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ----------------------------------------------------------------------------
// Every PtyHost method is implemented.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — PtyHost contract surface", () => {
  it("spawn round-trips through the framer and resolves with the SpawnResponse", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

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

  it("write base64-encodes the bytes and resolves on WriteResponse", async () => {
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

    // A kill on an exited session re-emits the cached exit and writes nothing to stdin.
    const stdinBefore = fake.readStdin().length;
    await host.kill("s-0", "SIGKILL");
    await flushMicrotasks();
    expect(exitFn).toHaveBeenCalledTimes(2);
    expect(fake.readStdin().length).toBe(stdinBefore);
  });

  it("close on unknown sessionId is a no-op (idempotent)", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });
    // Never spawned: close must neither throw nor start a sidecar.
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
// Content-Length wire format.
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
    // The header must be exactly `Content-Length: <n>` and a blank line before the JSON body.
    expect(stdin).toMatch(/^Content-Length: \d+\r\n\r\n\{/);
  });
});

// ----------------------------------------------------------------------------
// Sliding-window crash budget.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — sliding-window crash budget (Pin 5)", () => {
  it("respawns the sidecar within budget (4 crashes in 60s does NOT exhaust)", async () => {
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Four crashes inside the 60 s window; the supervisor must respawn after each.
    for (let i = 0; i < 4; i += 1) {
      clock.mockReturnValue(i * 1000);
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
      // Crash the child before it answers, so the budget is exercised without a SpawnResponse.
      seq.latest().triggerExit(1, null);
      // The pending request rejects; catch it to avoid an unhandled rejection.
      await reqPromise.catch(() => undefined);
    }
    expect(seq.spawned().length).toBe(4);

    // Only 4 crashes are in the window, so the fifth request respawns instead of failing.
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

    // The CRASH_BUDGET_LIMIT-th crash exhausts the budget.
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

    // The next request throws PtyBackendUnavailableError with attemptedBackend `rust-sidecar`.
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

    // Past the window the earlier crashes are evicted, so this crash starts a fresh window
    // and the host must still respawn.
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

    // Only one crash is in the current window, so another spawn is allowed.
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
    // (LIMIT - 1) + 1 + 1 spawns: the respawn after eviction is allowed.
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

    // Once the budget is spent the error carries the budget-exhausted message, not the
    // per-spawn ENOENT one.
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
// Binary path resolver failure.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — binary path resolver failure", () => {
  it("surfaces PtyBackendUnavailableError when resolveBinaryPath throws", async () => {
    const cause = new Error("not found");
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => {
        throw cause;
      },
      // Never reached: the resolver throws first.
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
    // The resolver is not observable from outside the class; assert only that construction
    // succeeds.
    const host = createRustSidecarPtyHost({ binaryPath: "/explicit/path" });
    expect(host).toBeInstanceOf(RustSidecarPtyHost);
  });

  it("constructs a host with no opts (production default — wires the four-step resolver)", () => {
    // With no options the factory wires `resolveSidecarBinaryPath` as the resolver; that resolver
    // has its own describe block below.
    const host = createRustSidecarPtyHost();
    expect(host).toBeInstanceOf(RustSidecarPtyHost);
  });
});

// ----------------------------------------------------------------------------
// Frame body cap.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — framing limits (defense in depth)", () => {
  it(`MAX_FRAME_BODY_BYTES is set to ${MAX_FRAME_BODY_BYTES} bytes (mirrors Rust framing::MAX_FRAME_BODY_BYTES)`, () => {
    // Pins the 8 MiB cap so it cannot drift from the Rust framer's `MAX_FRAME_BODY_BYTES`.
    expect(MAX_FRAME_BODY_BYTES).toBe(8 * 1024 * 1024);
  });
});

// ----------------------------------------------------------------------------
// `ContentLengthParser` driven directly: chunk-boundary reassembly and rejection paths.
// ----------------------------------------------------------------------------

describe("ContentLengthParser — chunk-boundary reassembly + rejection paths", () => {
  it("reassembles a frame split across two feed() calls (partial-read path)", () => {
    const parser = new ContentLengthParser();
    const body = Buffer.from('{"kind":"ping_response"}', "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    const full = Buffer.concat([header, body]);

    // Split mid-header: the parser cannot yet find the CRLFCRLF terminator.
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

    // Split mid-body: the header is complete but the body is short, so the parser waits.
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
    // Several frames arrive in one chunk; `drainParserUntilIncomplete` loops over `nextFrame`,
    // so the parser must hand them out one at a time without losing or merging any.
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
    // Without Content-Length the body length is unknown, so the parser returns the error result
    // that makes the supervisor SIGKILL and respawn the child.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("Content-Type: text/plain\r\n\r\nbody", "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/missing Content-Length header/i);
    }
  });

  it("rejects a frame with duplicate Content-Length headers (request-smuggling shape)", () => {
    // Two Content-Length values are the request-smuggling shape; the Rust framer rejects them too.
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

  // The `/^\d+$/` grammar is deliberately stricter than the Rust framer, which parses
  // `value.trim().parse::<usize>()` and so also accepts a leading `+`. The daemon rejects `+N` to
  // match HTTP/1.1 (`Content-Length = 1*DIGIT`, no sign), and rejects `12junk` and `12.5`, which
  // `Number.parseInt` would read as 12 while the Rust framer refuses them. The asymmetry is safe:
  // the sidecar never emits `+N`, and a `+N` frame dies at the daemon. Both sides trim outer
  // whitespace first, so `" 12"` and `"12 "` are accepted.
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
        // The offending value is echoed as a JSON string literal so a peer cannot inject CRLF or
        // control bytes into logs. The parser trims first, so the assertion uses the trimmed form.
        expect(result.message).toContain(JSON.stringify(raw.trim()));
      }
    });
  });

  // Accepted shapes: leading zeros and outer whitespace (removed by trim), as the Rust framer
  // accepts them.
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
    // The duplicate-header check must run before the grammar check, so a duplicate whose second
    // value is also malformed still reports the duplicate; otherwise a peer could mask a
    // smuggling attempt as a malformed value.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("Content-Length: 4\r\nContent-Length: 12junk\r\n\r\nbody", "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/duplicate Content-Length/i);
    }
  });

  it(`rejects a body length larger than MAX_FRAME_BODY_BYTES (${MAX_FRAME_BODY_BYTES})`, () => {
    // The cap is checked on the declared length before any body bytes arrive, so no 8 MiB body
    // is needed.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from(`Content-Length: ${MAX_FRAME_BODY_BYTES + 1}\r\n\r\n`, "utf8"));
    const result = parser.nextFrame();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/exceeds MAX_FRAME_BODY_BYTES/);
    }
  });

  // MAX_HEADER_BYTES stops `feed()` from buffering forever when a peer or a framing desync never
  // sends `\r\n\r\n`. It matches the per-section cap in `parseFrame` in
  // `src/ipc/local-ipc-gateway.ts`; the Rust framer instead caps each header line at 1 KiB.

  it(`MAX_HEADER_BYTES is set to 1024 bytes (mirrors the TS IPC sibling per-section cap)`, () => {
    // Pins the cap at the IPC framer's 1 KiB.
    expect(MAX_HEADER_BYTES).toBe(1024);
  });

  it("returns error when buffered bytes exceed MAX_HEADER_BYTES without CRLF CRLF terminator", () => {
    // A peer or desync streams header bytes that never terminate; the parser must stop
    // accumulating past MAX_HEADER_BYTES.
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
    // The delimiter is present but the header is oversized; the message differs from the
    // unterminated case so logs tell the two apart.
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
    // A partial header within the cap must not trip it, or frames split across two feeds would
    // be rejected.
    const parser = new ContentLengthParser();
    parser.feed(Buffer.from("Content-Length: 5", "utf8")); // 17 bytes, well under cap
    const result = parser.nextFrame();
    expect(result.kind).toBe("incomplete");
  });
});

// ----------------------------------------------------------------------------
// The parser is reset on child exit so the next sidecar does not inherit a half-read frame.
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

    // A non-numeric Content-Length trips the framer's error result; the supervisor SIGKILLs the
    // child.
    const corruptHeader = Buffer.from("Content-Length: NOT_A_NUMBER\r\n\r\n", "utf8");
    seq.latest().writeStdout(corruptHeader);
    await flushMicrotasks();

    // `drainParserUntilIncomplete` kills the child with SIGKILL on a framing error.
    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    // The exit records the crash, resets the parser and clears the child.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    // The next spawn starts a second sidecar with the reset parser; a well-formed frame must
    // decode despite the corrupt bytes from the first.
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
    // Stricter than the test above: a half header left on child A must not contaminate a full
    // frame from child B.
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

    // Deliver only the first half of a Content-Length header; the parser buffers it.
    seq.latest().writeStdout(Buffer.from("Content-Length: 27\r", "utf8"));
    await flushMicrotasks();

    // The exit must reset the parser, or the next sidecar's frames would be decoded after this
    // residue.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(1, null);
    await flushMicrotasks();

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

  // Late bytes on an exited child's stdout must not reach the fresh parser: teardown detaches
  // the stdout listener before swapping the parser.
  it("stale stdout from old child does NOT feed the fresh parser after handleChildExit", async () => {
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

    // The exit detaches child A's stdout listener before the parser swap.
    clock.mockReturnValue(100);
    childA.triggerExit(0, null);
    await flushMicrotasks();

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

    // A complete stale frame on the old child's stdout would, if its listener were still attached,
    // reach the fresh parser and resolve `spawnP2` with the stale session id.
    childA.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-STALE-OLD-CHILD" }));
    await flushMicrotasks();

    seq
      .latest()
      .writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-FRESH-NEW-CHILD" }));
    const response2 = await spawnP2;

    // Only the new child's frame resolves the request.
    expect(response2).toEqual({
      kind: "spawn_response",
      session_id: "s-FRESH-NEW-CHILD",
    });
  });

  // Same as above for the `error` event: `handleChildError` also detaches the listener and
  // resets the parser.
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

    childA.writeStdout(
      frameEnvelope({
        kind: "spawn_response",
        session_id: "s-STALE-FROM-ERRORED-CHILD",
      }),
    );
    await flushMicrotasks();

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
// kill, resize and write on a sessionId that was never spawned reject without touching the wire,
// as NodePtyHost does.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — sync throw on truly-unknown sessionId (NodePtyHost parity)", () => {
  it("kill() throws synchronously on a never-spawned sessionId (mirrors NodePtyHost)", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // Nothing was spawned, so the call must reject without touching the wire.
    await expect(host.kill("s-bogus", "SIGTERM")).rejects.toThrow(/unknown sessionId 's-bogus'/);
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
    // A kill that races the child's natural exit gets a typed error response from the sidecar;
    // the awaiting promise must reject instead of sitting in `outstanding` forever.
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

    // An explicit kill, not close(): close() swallows this error (tested below).
    const killP = host.kill("s-0", "SIGKILL");
    await flushMicrotasks();

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
    // A failed spawn gets a typed error response from the sidecar; the promise must reject
    // instead of hanging (a hang would fail on vitest's default 5 s timeout).
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

    // A failed spawn mints no session, so session_id is empty and error carries the diagnostic.
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
    // A failed spawn returns an empty session_id; the host must not track it, so later calls
    // on '' throw `unknown sessionId`.
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

    // The session table must not have grown: '' is still unknown.
    await expect(host.resize("", 30, 100)).rejects.toThrow(/unknown sessionId ''/);
  });

  it("does NOT register a session when SpawnResponse carries error (non-empty session_id)", async () => {
    // Even when the failed spawn response carries a non-empty session_id, the host must reject
    // before registering it; otherwise it would track a session the sidecar never created.
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

    // The failed id must not have been registered.
    await expect(host.write("s-failed", new Uint8Array([0]))).rejects.toThrow(
      /unknown sessionId 's-failed'/,
    );
  });

  it("emits exactly one frame on the spawn-failure round-trip (the SpawnRequest only)", async () => {
    // A failed spawn costs exactly one outbound frame, the SpawnRequest: no retry, close or kill
    // follows.
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

    const envelopes = parseFramesFromStdin(fake.readStdin());
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      kind: "spawn_request",
      command: "/nonexistent-binary",
    });
  });

  it("response with `error: undefined` (the success path) resolves normally and does NOT reject", async () => {
    // A response with `error` absent is a success, not a falsy error.
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
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(killP).resolves.toBeUndefined();
  });
});

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

    // close() stops the child with SIGTERM.
    const allFrames = parseFramesFromStdin(fake.readStdin().subarray(stdinBefore));
    expect(allFrames).toHaveLength(1);
    expect(allFrames[0]).toEqual({
      kind: "kill_request",
      session_id: "s-0",
      signal: "SIGTERM",
    });

    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(closeP).resolves.toBeUndefined();
  });

  it("close() swallows a wire-side error response (close MUST NOT throw on close-races-natural-exit)", async () => {
    // close() racing the child's natural exit gets a typed error response; close() must
    // swallow it.
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

    await expect(closeP).resolves.toBeUndefined();
  });

  it("close() suppresses subsequent onExit on late ExitCodeNotification (substitutability with NodePtyHost)", async () => {
    // close() removes the session record synchronously, so the sidecar's late exit notification
    // for it must not reach onExit. NodePtyHost likewise stops reporting exits after close():
    // consumers treat close() as terminal.
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

    const closeP = host.close("s-0");
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(closeP).resolves.toBeUndefined();

    // No onExit fired during the close() round-trip; only the late notification is under test.
    expect(exitFn).not.toHaveBeenCalled();

    // The sidecar's late exit notification arrives now and must be suppressed.
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
    // The exit notification can arrive before the kill_response. Here it lands while close() is
    // still awaiting the response. close() deletes the session record before dispatching the
    // kill, so the notification takes the closed-session branch and is suppressed; deleting
    // after the await would fire onExit mid-close.
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

    // Start close() without delivering the kill_response yet.
    const closeP = host.close("s-0");
    await flushMicrotasks();

    // The exit notification lands first, while close() is pending, and must be suppressed.
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

    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(closeP).resolves.toBeUndefined();

    expect(exitFn).not.toHaveBeenCalled();
  });
});

describe("RustSidecarPtyHost — data_frame fan-out gating", () => {
  it("does NOT call the data listener for a session that has been close()d", async () => {
    // A DataFrame for a closed session is dropped, not fanned out to a stale listener, as
    // NodePtyHost does after close().
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

    // A late DataFrame can still arrive after close().
    void host.close("s-0");
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await flushMicrotasks();

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

    expect(dataFn).not.toHaveBeenCalled();
  });
});

// The sidecar starts its reader and waiter tasks before it queues the SpawnResponse, and its
// writer merge picks between channels without bias. So a DataFrame or ExitCodeNotification can
// share a stdout chunk with the SpawnResponse. The host registers the session synchronously on
// spawn_response so those trailing frames are delivered rather than dropped.

describe("RustSidecarPtyHost — same-stdout-chunk frame coalescing", () => {
  it("delivers DataFrame arriving same-chunk after SpawnResponse to onData", async () => {
    // Both frames arrive in one chunk; the DataFrame must be dispatched with the session already
    // registered.
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
    // Same race for a short-lived process: the exit notification trails the SpawnResponse in one
    // chunk and must still reach onExit.
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
    // A short-lived process: the DataFrame and ExitCodeNotification both trail the SpawnResponse
    // in one chunk, and both must reach their listeners.
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

// Pre-spawn buffering. For a child that lives under a millisecond, a DataFrame or
// ExitCodeNotification can reach the wire before its SpawnResponse (the sidecar's reader and
// waiter tasks start before the response is queued, and its writer merge is unbiased; see
// spawn in pty_session.rs and merge_to_writer in main.rs). The host buffers such events by
// session_id, replays them after registering the session, and defers the replay with
// setImmediate so the caller's `await spawn()` continuation records the id before onData or
// onExit fires. NodePtyHost has no such race because its spawn is synchronous.

describe("RustSidecarPtyHost — pre-spawn event buffering", () => {
  /** Waits one I/O turn so `setImmediate` callbacks scheduled earlier have run. */
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

    // Wire order: DataFrame first, then SpawnResponse.
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

    await flushSetImmediate();

    // onData fires after spawn() resolves; the buffered chunk is not lost.
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

    // Wire order: ExitCodeNotification first, then SpawnResponse.
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

    // Wire order: DataFrame, ExitCodeNotification, SpawnResponse; the replay keeps arrival order.
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

    // Chunk 1: the DataFrame alone lands in the pre-spawn buffer.
    fake.writeStdout(
      frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: Buffer.from("hi\n", "utf8").toString("base64"),
      }),
    );
    // Let the drain loop settle the DataFrame into the buffer before chunk 2.
    await flushMicrotasks();

    // Chunk 2: the SpawnResponse registers the session and schedules the replay.
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));

    await spawnP;
    events.push({ tag: "spawn-resolved" });

    await flushSetImmediate();

    expect(events.map((e) => e.tag)).toEqual(["spawn-resolved", "data"]);
    expect(events[1]).toMatchObject({ tag: "data", text: "hi\n" });
  });

  it("PE5 — pre-spawn buffer cleared on supervisor teardown so pre-respawn events do not replay against fresh post-respawn session", async () => {
    // The sidecar's session ids (`s-{n}`) restart after a respawn. A pre-crash DataFrame for `s-0`
    // that never got its SpawnResponse must not replay against the new child's `s-0`;
    // handleChildExit clears the pre-spawn buffer.
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

    // Pre-crash: no SpawnResponse arrives; the child emits a DataFrame for `s-0` and crashes.
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
    // Crash the first child; handleChildExit clears the buffer.
    seq.latest().triggerExit(1, null);
    await preCrashSpawnP.catch(() => undefined);

    // Post-respawn: the new child answers with SpawnResponse(s-0) and a fresh DataFrame.
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

    // Only the post-respawn DataFrame reaches the consumer.
    expect(observed).toEqual(["FRESH\n"]);
  });

  it("PE5b — closed-session-id retention cleared on supervisor teardown so post-respawn fresh session is not suppressed", async () => {
    // Same as above for `closedSessionIds`: an id closed before the crash must not suppress the
    // fresh post-respawn session that reuses it. handleChildExit clears it through
    // `clearPreSpawnState`.
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

    // Pre-crash: spawn, then close() (records s-0 as closed).
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

    // Crash the first child; teardown clears closedSessionIds.
    seq.latest().triggerExit(1, null);

    // Post-respawn: a fresh session reuses the wire id s-0.
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

    // The fresh DataFrame reaches the consumer: s-0 is alive again, not suppressed.
    expect(observed).toEqual(["FRESH\n"]);
  });

  it("PE6 — late ExitCodeNotification arriving after close() is suppressed (not buffered)", async () => {
    // A session closed while alive must suppress a late ExitCodeNotification. Without
    // `closedSessionIds` the unknown-session branch would buffer it as a pre-spawn event,
    // where it would leak until supervisor teardown.
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

    // Close before the child exits.
    const closeP = host.close("s-0");
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await closeP;

    // A late ExitCodeNotification must be suppressed.
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

describe("RustSidecarPtyHost — dual error+exit events do not double-charge the crash budget", () => {
  it("emits both 'error' and 'exit' for the same child; budget is consumed exactly once", async () => {
    // Node's `child_process` can emit both `error` and `exit` for one failed child. Without the
    // per-child dedupe (`crashCountedChildren`) each handler charges the crash budget, so it
    // would exhaust at half the limit.
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Crash CRASH_BUDGET_LIMIT - 1 children, each emitting both events. Without the dedupe the
    // budget would already be exhausted, and the next spawn would be refused.
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
      seq.latest().triggerError(new Error("spawn-init crash"));
      seq.latest().triggerExit(1, null);
      await reqP.catch(() => undefined);
    }

    // Only CRASH_BUDGET_LIMIT - 1 crashes were counted, so the budget still has room.
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
    expect(seq.spawned().length).toBe(CRASH_BUDGET_LIMIT);
  });
});

// Node's `child_process` can emit both `exit` and `error` for one failed child. After the first
// event tears down and `ensureChild()` spawns a replacement, a late second event for the old
// child must not touch the new one: it would wipe `this.child`, detach a listener from the wrong
// stream, and reject the new child's pending requests. `handleChildExit` and `handleChildError`
// guard with `this.child !== child`; `crashCountedChildren` only dedupes budget consumption.

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

    // The first exit tears down child A on the active-child path.
    clock.mockReturnValue(100);
    childA.triggerExit(1, null);
    await flushMicrotasks();

    // A fresh request spawns child B. Keep the `childA` handle for the stale exit below.
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

    // A second `exit` for the old child A, arriving after B was spawned (Node can emit `exit`
    // twice, or `error` then `exit`). Without the stale-event guard it would clear `this.child`
    // (B) and reject B's pending spawn.
    childA.triggerExit(1, null);
    await flushMicrotasks();

    // `this.child` is still B; the field is private, hence the cast.
    const hostInternals: { child: SidecarChildProcess | null } = host as unknown as {
      child: SidecarChildProcess | null;
    };
    expect(hostInternals.child).toBe(childB.child);

    // B's pending spawn resolves through B's response; the stale event did not reject it.
    childB.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    await expect(spawnP2).resolves.toEqual({ kind: "spawn_response", session_id: "s-1" });
  });

  it("stale 'error' event for an old child after replacement does not clear the new child", async () => {
    // `handleChildError` shares the stale-event guard with `handleChildExit`; this pins the
    // async-error path.
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

    // A stale second `error` for the old child A; the guard keeps it from clobbering B.
    childA.triggerError(new Error("late stale error event"));
    await flushMicrotasks();

    const hostInternals: { child: SidecarChildProcess | null } = host as unknown as {
      child: SidecarChildProcess | null;
    };
    expect(hostInternals.child).toBe(childB.child);

    childB.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    await expect(spawnP2).resolves.toEqual({ kind: "spawn_response", session_id: "s-1" });
  });

  it("error after exit on the same child runs teardown only once (regression preservation)", async () => {
    // The second event returns at the stale-event guard, so the crash budget is charged once and
    // the child reference is cleared once.
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

    // Fire both events for the same child with no replacement between them: the first tears
    // down, the second is stale because `this.child` is already null.
    clock.mockReturnValue(50);
    childA.triggerExit(1, null);
    await flushMicrotasks();
    childA.triggerError(new Error("late error after exit"));
    await flushMicrotasks();

    await expect(spawnP).rejects.toThrow(/sidecar exited/);

    // The stale second event must not latch the supervisor: the next request spawns a fresh child.
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
// Crash-time onExit: when the sidecar dies, every session still in the map gets
// `onExit(sessionId, -1)` and is deleted. A session whose exit code is already cached is not
// re-fired, a throwing listener does not strand the rest, and a stale event never fires against
// a replacement child's sessions.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — crash-time per-session onExit", () => {
  it("handleChildExit fires onExit(-1) for every active session and empties the session map", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const exitFn = vi.fn();
    host.setOnExit(exitFn);

    const sessionIds = ["s-0", "s-1", "s-2"] as const;
    for (const sessionId of sessionIds) {
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
      fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: sessionId }));
      await spawnP;
    }
    // `sessions` is private, so read it through a cast.
    const internals: { sessions: Map<string, unknown> } = host as unknown as {
      sessions: Map<string, unknown>;
    };
    expect(internals.sessions.size).toBe(3);

    fake.triggerExit(1, null);
    await flushMicrotasks();

    expect(exitFn).toHaveBeenCalledTimes(3);
    expect(exitFn.mock.calls).toEqual(
      expect.arrayContaining([
        ["s-0", -1],
        ["s-1", -1],
        ["s-2", -1],
      ]),
    );
    // The crash-time fire passes two arguments; `signalCode` is omitted.
    for (const call of exitFn.mock.calls) {
      expect(call).toHaveLength(2);
    }
    expect(internals.sessions.size).toBe(0);
  });

  it("handleChildError fires onExit(-1) for every active session and empties the session map", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const exitFn = vi.fn();
    host.setOnExit(exitFn);

    const sessionIds = ["s-0", "s-1"] as const;
    for (const sessionId of sessionIds) {
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
      fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: sessionId }));
      await spawnP;
    }
    const internals: { sessions: Map<string, unknown> } = host as unknown as {
      sessions: Map<string, unknown>;
    };
    expect(internals.sessions.size).toBe(2);

    fake.triggerError(new Error("sidecar SIGABRT"));
    await flushMicrotasks();

    expect(exitFn).toHaveBeenCalledTimes(2);
    expect(exitFn.mock.calls).toEqual(
      expect.arrayContaining([
        ["s-0", -1],
        ["s-1", -1],
      ]),
    );
    expect(internals.sessions.size).toBe(0);
  });

  it("does NOT re-fire onExit for a session whose normal-path exit already cached an exitCode", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const exitFn = vi.fn();
    host.setOnExit(exitFn);

    for (const sessionId of ["s-0", "s-1"] as const) {
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
      fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: sessionId }));
      await spawnP;
    }

    // s-0 exits normally: its exit code is cached and onExit fires once.
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

    // The crash skips s-0 (exit code already cached) and fires only for s-1; the map is emptied
    // either way.
    fake.triggerExit(1, null);
    await flushMicrotasks();

    expect(exitFn).toHaveBeenCalledTimes(2);
    expect(exitFn).toHaveBeenNthCalledWith(2, "s-1", -1);
    const internals: { sessions: Map<string, unknown> } = host as unknown as {
      sessions: Map<string, unknown>;
    };
    expect(internals.sessions.size).toBe(0);
  });

  it("clears the session map for already-exited sessions so write/resize throw unknown sessionId after a crash", async () => {
    // Regression: skipping a cached-exit session on crash would leave its id in `this.sessions`.
    // `resize` and `write` gate only on `sessions.has`, so the stale id would respawn the sidecar
    // and be sent to a child that has no record of it. Crash teardown always deletes the record.
    const seq = spawnReturningSequence();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
    });
    host.setOnExit(vi.fn());

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
    childA.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    // s-0 exits normally: its exit code is cached but the record stays in the map (only
    // `close()` deletes it).
    childA.writeStdout(
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
    );
    await flushMicrotasks();

    // After the crash s-0 is gone from the map even though its exit code was already set.
    childA.triggerExit(1, null);
    await flushMicrotasks();

    await expect(host.resize("s-0", 24, 80)).rejects.toThrow(
      /RustSidecarPtyHost\.resize: unknown sessionId 's-0'/,
    );
    await expect(host.write("s-0", new Uint8Array([0x68, 0x69]))).rejects.toThrow(
      /RustSidecarPtyHost\.write: unknown sessionId 's-0'/,
    );

    // Both calls were rejected before `ensureChild()`, so the sidecar was not respawned.
    expect(seq.latest()).toBe(childA);
  });

  it("late ExitCodeNotification arriving on the respawned sidecar does NOT double-fire onExit", async () => {
    const seq = spawnReturningSequence();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
    });

    const exitFn = vi.fn();
    host.setOnExit(exitFn);

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

    childA.triggerExit(1, null);
    await flushMicrotasks();
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith("s-0", -1);

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
    const childB = seq.latest();
    expect(childB).not.toBe(childA);

    // A stale exit notification for the deleted s-0 arrives on child B. There is no record, so it
    // goes to the pre-spawn buffer and the listener is not called again.
    childB.writeStdout(
      frameEnvelope({
        kind: "exit_code_notification",
        session_id: "s-0",
        exit_code: 0,
        signal_code: null,
      }),
    );
    await flushMicrotasks();
    expect(exitFn).toHaveBeenCalledTimes(1);

    // Resolve B's spawn so the pending promise does not leak.
    childB.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    await spawnP2;
  });

  it("a listener that throws on one session does NOT strand remaining sessions in the map", async () => {
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // Silence the console.warn from the listener-throws path.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const exitFn = vi.fn().mockImplementation((sessionId: string) => {
      if (sessionId === "s-1") {
        throw new Error("listener bug on s-1");
      }
    });
    host.setOnExit(exitFn);

    for (const sessionId of ["s-0", "s-1", "s-2"] as const) {
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
      fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: sessionId }));
      await spawnP;
    }

    // The listener throws on s-1; the loop still fires s-0 and s-2 and empties the map.
    fake.triggerExit(1, null);
    await flushMicrotasks();

    expect(exitFn).toHaveBeenCalledTimes(3);
    const internals: { sessions: Map<string, unknown> } = host as unknown as {
      sessions: Map<string, unknown>;
    };
    expect(internals.sessions.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/crash-time onExit listener threw for session s-1/);

    warnSpy.mockRestore();
  });

  it("composes BELOW the stale-event guard — late stale exit for an old child does not re-fire onExit", async () => {
    const seq = spawnReturningSequence();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
    });

    const exitFn = vi.fn();
    host.setOnExit(exitFn);

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

    childA.triggerExit(1, null);
    await flushMicrotasks();
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith("s-0", -1);

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
    const childB = seq.latest();
    childB.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    await spawnP2;

    // A stale second exit for the old child A must return at the stale-event guard, before
    // `fireCrashTimeOnExit`, so B's session s-1 is not fired.
    childA.triggerExit(1, null);
    await flushMicrotasks();

    // onExit fired once (A's real crash); s-1 stays in the map under child B.
    expect(exitFn).toHaveBeenCalledTimes(1);
    const internals: { sessions: Map<string, unknown>; child: unknown } = host as unknown as {
      sessions: Map<string, unknown>;
      child: unknown;
    };
    expect(internals.sessions.has("s-1")).toBe(true);
    expect(internals.child).toBe(childB.child);
  });
});

// ----------------------------------------------------------------------------
// `resolveSidecarBinaryPath`: four-step resolution (env var, installed package, release build,
// debug build). The first hit wins and later steps are not consulted. When every step misses it
// throws `PtyBackendUnavailableError` listing each step, with the step-2 error as `cause`.
// ----------------------------------------------------------------------------

describe("resolveSidecarBinaryPath — four-step binary resolution", () => {
  // Builds injectable deps whose defaults (empty env, throwing require, false existsSync) make
  // each test opt in to the step it exercises.
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

  it("step 1 hits when AIS_PTY_SIDECAR_BIN is set to an absolute path that exists (steps 2/3/4 NOT consulted)", () => {
    // The step-1 hit also probes existsSync so a stale env path cannot pass. Steps 2-4 must not
    // be consulted (requireMock is never called).
    const existsMock = vi.fn<(p: string) => boolean>((p) => p === "/abs/path/to/sidecar");
    const { opts, requireMock } = makeOpts({
      env: { AIS_PTY_SIDECAR_BIN: "/abs/path/to/sidecar" },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/abs/path/to/sidecar");
    // One existsSync probe, against the env value; no release or debug probes.
    expect(existsMock).toHaveBeenCalledTimes(1);
    expect(existsMock).toHaveBeenCalledWith("/abs/path/to/sidecar");
    expect(requireMock).not.toHaveBeenCalled();
  });

  it("step 1 rejects an absolute path that does not exist on disk and falls through to step 2", () => {
    // Without the existsSync guard a stale env path would be returned, and every doomed spawn
    // would count against the 5-per-60s crash budget, making the host permanently unavailable
    // after five attempts. The resolver rejects it and falls through to step 2.
    const step2Mock = vi.fn<(id: string) => string>(() => "/installed/pkg/bin/sidecar");
    const existsMock = vi.fn<(p: string) => boolean>(() => false);
    const { opts } = makeOpts({
      env: { AIS_PTY_SIDECAR_BIN: "/tmp/path/that/does/not/exist" },
      nodeRequire: { resolve: step2Mock },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/installed/pkg/bin/sidecar");
    // Step 1's existsSync probe ran against the env value, returned
    // The env path was probed, returned false, and step 2 took over.
    expect(existsMock).toHaveBeenCalledWith("/tmp/path/that/does/not/exist");
    expect(step2Mock).toHaveBeenCalledTimes(1);
  });

  it("rejects-and-enumerates a non-existent absolute step-1 attempt when all four steps miss", () => {
    // When the env path misses and every other step misses too, the error names the exact
    // rejected value.
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("not found");
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);
    const { opts } = makeOpts({
      env: { AIS_PTY_SIDECAR_BIN: "/tmp/missing/sidecar" },
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
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toMatch(
        /step 1 \(env-var AIS_PTY_SIDECAR_BIN\): rejected \(path does not exist\): "\/tmp\/missing\/sidecar"/,
      );
    }
  });

  it("step 1 rejects a relative path (NOT coerced to absolute) and falls through to step 2", () => {
    // A relative path depends on process.cwd(), so the resolver rejects it instead of making it
    // absolute, then consults step 2.
    const step2Mock = vi.fn<(id: string) => string>(() => "/from/step-2/sidecar");
    const { opts } = makeOpts({
      env: { AIS_PTY_SIDECAR_BIN: "./relative/sidecar" },
      nodeRequire: { resolve: step2Mock },
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/from/step-2/sidecar");
    // Step 2 ran, so step 1 did not return the relative path.
    expect(step2Mock).toHaveBeenCalledTimes(1);
  });

  it("step 2 hits when require.resolve returns a path (steps 3/4 NOT consulted)", () => {
    const requireMock = vi.fn<(id: string) => string>(() => "/installed/pkg/bin/sidecar");
    const { opts, existsMock } = makeOpts({
      nodeRequire: { resolve: requireMock },
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/installed/pkg/bin/sidecar");
    // The package id embeds platform and arch.
    expect(requireMock).toHaveBeenCalledTimes(1);
    expect(requireMock).toHaveBeenCalledWith(
      "@ai-sidekicks/pty-sidecar-linux-" + process.arch + "/bin/sidecar",
    );
    // No filesystem probes for steps 3 and 4.
    expect(existsMock).not.toHaveBeenCalled();
  });

  it("step 3 hits when require.resolve throws but the release binary exists on disk (step 4 NOT consulted)", () => {
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("Cannot find module '@ai-sidekicks/pty-sidecar-linux-x64'");
    });
    // The release probe succeeds; step 4 must not be probed.
    const existsMock = vi.fn<(p: string) => boolean>((p) => p === "/fake/release/sidecar");
    const { opts } = makeOpts({
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/fake/release/sidecar");
    // Only the release path was probed; step 4 was skipped.
    expect(existsMock).toHaveBeenCalledTimes(1);
    expect(existsMock).toHaveBeenCalledWith("/fake/release/sidecar");
  });

  it("step 4 hits when only the debug binary exists on disk", () => {
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
    // Release was probed first, then debug.
    expect(existsMock).toHaveBeenCalledTimes(2);
    expect(existsMock).toHaveBeenNthCalledWith(1, "/fake/release/sidecar");
    expect(existsMock).toHaveBeenNthCalledWith(2, "/fake/debug/sidecar");
  });

  it("all four steps exhausted → throws PtyBackendUnavailableError enumerating every step failure", () => {
    // Fresh checkout with no cargo build and no install: the case this error exists for.
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

    // The message enumerates every step's failure, not just "binary not found".
    expect(thrown.message).toMatch(/step 1 \(env-var AIS_PTY_SIDECAR_BIN\): unset/);
    expect(thrown.message).toMatch(/step 2 \(require\.resolve.*\): threw:/);
    expect(thrown.message).toMatch(
      /step 3 \(packages\/sidecar-rust-pty\/target\/release\/sidecar\): not found at \/fake\/release\/sidecar/,
    );
    expect(thrown.message).toMatch(
      /step 4 \(packages\/sidecar-rust-pty\/target\/debug\/sidecar\): not found at \/fake\/debug\/sidecar/,
    );

    // `cause` is the step-2 error: the closest miss on the production path (step 1 is a developer
    // override; steps 3 and 4 are workspace paths).
    expect(thrown.details.cause).toBe(requireError);
  });

  it("rejects-and-enumerates a relative-path step-1 attempt when all four steps miss", () => {
    // Same as above, but step 1 was tried and rejected as a relative path; the message names the
    // rejected value.
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
        /step 1 \(env-var AIS_PTY_SIDECAR_BIN\): rejected \(relative path; absolute required\): "\.\/relative\/path"/,
      );
    }
  });

  it("on Windows, probes 'sidecar.exe' (not 'sidecar') for step 2 and embeds .exe in step 3/4 diagnostics", () => {
    // The resolver must add the `.exe` suffix on Windows.
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

    expect(requireMock).toHaveBeenCalledWith(
      "@ai-sidekicks/pty-sidecar-win32-" + process.arch + "/bin/sidecar.exe",
    );
    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toMatch(
        /step 3 \(packages\/sidecar-rust-pty\/target\/release\/sidecar\.exe\)/,
      );
      expect(thrown.message).toMatch(
        /step 4 \(packages\/sidecar-rust-pty\/target\/debug\/sidecar\.exe\)/,
      );
    }
  });

  it("treats an empty-string AIS_PTY_SIDECAR_BIN identically to unset (falls through to step 2)", () => {
    // A shell can export `AIS_PTY_SIDECAR_BIN=` as an empty string. It must count as unset rather
    // than be returned as a path that fails later with a less useful ENOENT.
    const requireMock = vi.fn<(id: string) => string>(() => "/installed/pkg/bin/sidecar");
    const { opts } = makeOpts({
      env: { AIS_PTY_SIDECAR_BIN: "" },
      nodeRequire: { resolve: requireMock },
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/installed/pkg/bin/sidecar");
    expect(requireMock).toHaveBeenCalledTimes(1);
  });

  it("step 3/4 default paths land inside packages/sidecar-rust-pty/target/{release,debug}/ (pins workspaceTargetPath ascent depth)", () => {
    // The other resolver tests pass `releasePath` and `debugPath`, which skips the real
    // `workspaceTargetPath` ascent, so a miscounted `../` depth would leave them green. This test
    // omits the overrides and checks the probed paths land in
    // `packages/sidecar-rust-pty/target/{release,debug}/`. It compares `path.sep`-suffixed
    // strings so it holds on POSIX and Windows.
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("Cannot find module (step-2 forced miss)");
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);

    let thrown: unknown = null;
    try {
      // No path overrides; `platform: "linux"` keeps the binary name free of `.exe`.
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

    // The two existsSync probes are the release and debug paths.
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

    // The rendered diagnostic must embed the same paths that were probed.
    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toContain(releaseSuffix);
      expect(thrown.message).toContain(debugSuffix);
    }
  });
});

// ----------------------------------------------------------------------------
// `ensureChild` re-throws a resolver-thrown `PtyBackendUnavailableError` unchanged, so its
// step-by-step message stays readable instead of buried in `details.cause`. A plain `Error` from
// a custom resolver is still wrapped.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — ensureChild preserves resolver-thrown PtyBackendUnavailableError", () => {
  it("re-throws the resolver's PtyBackendUnavailableError unchanged (same instance, original message intact)", async () => {
    // A resolver error with a recognizable step-enumerated message; `ensureChild` must surface
    // this same instance, not wrap it.
    const innerCause: Error = new Error("Cannot find module '@ai-sidekicks/pty-sidecar-linux-x64'");
    const resolverError: PtyBackendUnavailableError = new PtyBackendUnavailableError(
      { attemptedBackend: "rust-sidecar", cause: innerCause },
      "RustSidecarPtyHost: sidecar binary not found on any of the four resolution steps " +
        ". Attempts:\n" +
        "  step 1 (env-var AIS_PTY_SIDECAR_BIN): unset\n" +
        "  step 2 (require.resolve(...)): threw: Cannot find module\n" +
        "  step 3 (...): not found at /workspace/.../release/sidecar\n" +
        "  step 4 (...): not found at /workspace/.../debug/sidecar\n" +
        "Set AIS_PTY_SIDECAR_BIN=...",
    );

    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => {
        throw resolverError;
      },
      // The spawn function must never be reached.
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

    // Same-instance check: a wrapper that carries the original as `details.cause` would fail
    // `.toBe`.
    expect(thrown).toBe(resolverError);
    // A rebuilt error that keeps the same `details.cause` would pass an `instanceof` check, so
    // also assert the message and cause survive.
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toContain("not found on any of the four resolution steps");
      expect(thrown.message).toContain("step 1 (env-var AIS_PTY_SIDECAR_BIN): unset");
      expect(thrown.details.cause).toBe(innerCause);
    }
  });

  it("still wraps a plain Error from a custom resolver (preserves prior wrap-branch behavior)", async () => {
    // A future widening of the passthrough guard (e.g. to `instanceof Error`) must not let plain
    // errors through without the `attemptedBackend` tag.
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
      // Wrapped, not passed through.
      expect(thrown).not.toBe(cause);
      expect(thrown.details.attemptedBackend).toBe("rust-sidecar");
      expect(thrown.details.cause).toBe(cause);
      expect(thrown.message).toBe("RustSidecarPtyHost: failed to resolve sidecar binary path");
    }
  });
});

// ----------------------------------------------------------------------------
// `ensureChild`: concurrent cold-start callers share a single spawn.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — ensureChild concurrent-spawn serialization", () => {
  it("serializes N parallel cold-start callers onto a single spawnFn invocation", async () => {
    // On a cold host, parallel calls (several `spawn`s, or `write` racing `kill`) each await
    // `ensureChild`. Without the memoized in-flight promise each would reach `spawnFn` and orphan
    // all but the last child.
    const fake = makeFakeChild();
    const spawnFn = vi
      .fn<SidecarSpawnFn>()
      .mockImplementation(() => fake.child as unknown as ReturnType<SidecarSpawnFn>);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnFn,
    });

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

    // One child receives all five requests on the same stdin; answer each.
    for (let i = 0; i < 5; i += 1) {
      fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: `s-${i}` }));
    }
    const responses = await Promise.all(requests);

    // Load-bearing: `spawnFn` ran once, not once per caller.
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // No caller was rejected by an orphaned child.
    expect(responses).toHaveLength(5);
    for (const response of responses) {
      expect(response).toMatchObject({ kind: "spawn_response" });
    }

    // The single live child still accepts wire traffic: a `write` must frame onto the same stdin
    // that received the spawn requests.
    const stdinBefore = fake.readStdin().length;
    const writeP = host.write("s-0", new Uint8Array([0x61])); // "a"
    await flushMicrotasks();
    expect(fake.readStdin().length).toBeGreaterThan(stdinBefore);
    fake.writeStdout(frameEnvelope({ kind: "write_response", session_id: "s-0" }));
    await expect(writeP).resolves.toBeUndefined();
  });

  it("clears the in-flight latch on failure so the next call retries (crash budget consumed once)", async () => {
    // A failed cold start must clear `inflightSpawn` so the next call retries. A stuck latch
    // would replay the cached failure or double-charge the crash budget.
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

    // The first spawn fails synchronously (ENOENT), is wrapped in `PtyBackendUnavailableError`,
    // and uses one budget slot.
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

    // The second spawn must call `spawnFn` again; a stale `inflightSpawn` would replay attempt
    // 1's failure.
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

    // Check the budget was charged once, through the sliding window: after one slot the host
    // tolerates `CRASH_BUDGET_LIMIT - 1` more synchronous failures. The live sidecar must exit
    // first so the next request spawns fresh; that exit is a crash and uses a second slot.
    // That exit is itself a crash event — so it consumes one
    // additional slot, bringing the total used to 2.
    fake.triggerExit(1, null);
    await flushMicrotasks();

    // Every later spawn throws ENOENT and uses a slot.
    spawnFn.mockImplementation(() => {
      const e = new Error("ENOENT") as Error & { code?: string };
      e.code = "ENOENT";
      throw e;
    });

    // Two slots are used (the first ENOENT plus the sidecar exit), so `CRASH_BUDGET_LIMIT - 2`
    // more failures reach the limit and the last one exhausts the budget. A double charge on the
    // first failure would exhaust it one iteration early.
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
      // These are per-spawn ENOENT wraps; the budget-exhausted message appears only on the call
      // after the limit is reached.
      if (caught instanceof PtyBackendUnavailableError) {
        expect(caught.message).not.toMatch(/crash-respawn budget exhausted/);
      }
    }

    // The next request must report budget exhaustion; a double charge would do so a cycle earlier.
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
// Async pipe errors (ERR_STREAM_DESTROYED, EPIPE, EIO) on the sidecar's stdin, stdout and stderr
// fire as `'error'` events and bypass any try/catch around `child.stdin.write`; unhandled they
// become `uncaughtException` and crash the daemon. The supervisor consumes each one and SIGTERMs
// the child so `handleChildExit` rejects outstanding requests. `child.on('error')` covers only
// process errors, not stream errors.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — pipe error handlers", () => {
  // One parameterized test covers all three streams: the production handler is shared, so a fix
  // for one stream alone would leave the others able to crash the daemon.
  it.each([
    { which: "stdin" as const, errMsg: "write EPIPE" },
    { which: "stdout" as const, errMsg: "read EIO" },
    { which: "stderr" as const, errMsg: "read EIO" },
  ])(
    "consumes async error on child.$which and triggers SIGTERM-driven cleanup without escalating to uncaughtException",
    async ({ which, errMsg }) => {
      // Capture `uncaughtException` before the body. Without a listener Node would raise it after
      // the test finished and the regression would go unseen. Vitest installs its own handler, but
      // that can be configured away.
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

        // The pending spawn is an outstanding request, and `attachChildListeners` wires the
        // stream listeners.
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

        // Without the production listener this would escalate to `uncaughtException`.
        fake.child[which].emit("error", new Error(errMsg));

        // Simulate the child exit that follows the SIGTERM; `handleChildExit` rejects outstanding
        // requests.
        fake.triggerExit(null, "SIGTERM");

        await expect(spawnP).rejects.toThrow(/sidecar exited/);

        expect(uncaught).toHaveLength(0);

        const killMock = fake.child.kill as ReturnType<typeof vi.fn>;
        expect(killMock).toHaveBeenCalledWith("SIGTERM");
      } finally {
        process.off("uncaughtException", captureUncaught);
      }
    },
  );
});

// ----------------------------------------------------------------------------
// A payload that decodes badly is fatal to the child, like a framing error: the supervisor
// SIGKILLs it, rejects outstanding requests with a `SidecarFrameDecodeError`, and respawns on the
// next request. Shapes and their `decodeCause`:
//   (a) `{garbage`          JSON.parse throws: "json-parse".
//   (b) `null` or `[1,2,3]` valid JSON but not an object envelope: "non-object-envelope". An
//                           array passes a typeof/null check but has no `.kind`, so it needs
//                           its own `Array.isArray` guard.
//   (c) `{"kind":"future"}` an object whose `kind` matches no `Envelope` variant (version skew or
//                           a sidecar bug): "unknown-kind".
// ----------------------------------------------------------------------------

/**
 * Frames a raw string body as a Content-Length frame, for payloads `frameEnvelope` cannot
 * produce (invalid JSON, `null`, an array).
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

    // Two outstanding requests of different kinds, so the test covers every pending promise
    // and not just one queue head.
    const resizeP = host.resize("s-0", 30, 100);
    const writeP = host.write("s-0", new Uint8Array([0x68, 0x69])); // "hi"
    await flushMicrotasks();

    // A correctly framed body that is not valid JSON.
    seq.latest().writeStdout(frameRawBody("{garbage"));
    await flushMicrotasks();

    // (i) SIGKILL, as on the framing-error path.
    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    // The exit event makes the supervisor charge the budget and run teardown.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    // (ii) Every queued request rejects with the typed decode error, not the generic "sidecar
    // exited" (which would mean the cause was not passed along).
    await expect(resizeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(resizeP).rejects.toThrow(/failed to parse inbound JSON envelope/);
    await expect(writeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(writeP).rejects.toThrow(/failed to parse inbound JSON envelope/);

    // The `toBeInstanceOf` checks above are load-bearing: if one failed, the `instanceof`
    // narrowing below would skip the `decodeCause` check silently, because Vitest continues past
    // failed assertions.
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

    // (iii) One crash is not permanent: the next request respawns.
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
    // Five JSON-decode failures in a row, one per respawn, exhaust `CRASH_BUDGET_LIMIT` on the
    // fifth. Counting each failure both in `handleInbound` and in the exit handler would exhaust
    // it on the third.
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    for (let i = 0; i < CRASH_BUDGET_LIMIT; i++) {
      clock.mockReturnValue(i * 100);
      // Each crash needs a request in flight, or `ensureChild` would not spawn a fresh child.
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

    // The next spawn reports the exhausted budget.
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
    // `JSON.parse("null")` returns null rather than throwing. The post-parse guard gives the same
    // teardown as a parse failure, instead of a TypeError on `null.kind`.
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
    // An array passes `typeof x === "object"` and `!== null`, so it needs its own guard: without
    // it `envelope.kind` is undefined, no `case` matches, and outstanding promises hang. It is a
    // decode failure, not an unknown variant, because an array cannot be an `Envelope`. The
    // message says `observedKind=array` to tell it from `null`.
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
    // If two malformed frames arrive in one chunk, the first kills the child and stashes the
    // cause; the second must see `pendingTeardownCause` in `failFatallyOnDecodeError` and skip
    // the kill.
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

    // Two malformed frames in one write; the parser drains both before yielding.
    const twoBad: Buffer = Buffer.concat([frameRawBody("{garbage"), frameRawBody("null")]);
    seq.latest().writeStdout(twoBad);
    await flushMicrotasks();

    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    const sigkillCalls = killMock.mock.calls.filter(
      (call: readonly unknown[]) => call[0] === "SIGKILL",
    );
    expect(sigkillCalls.length).toBe(1);
  });

  it("(c) unknown envelope kind triggers fatal teardown with decodeCause='unknown-kind'", async () => {
    // A version skew or sidecar bug can emit a `kind` that no `Envelope` variant has. The object
    // guards pass, so the `default:` arm in `handleInbound` must trigger the same teardown;
    // otherwise queued promises hang.
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

    // An outstanding request that the teardown must reject with the typed error.
    const resizeP = host.resize("s-0", 30, 100);
    await flushMicrotasks();

    // A well-formed object whose `kind` is unknown to the daemon.
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

    // (i) SIGKILL, as on the earlier paths.
    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    // The exit event makes the supervisor charge the budget and run teardown.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    // (ii) The queued resize rejects with decodeCause 'unknown-kind', and the message names the
    // offending kind.
    await expect(resizeP).rejects.toBeInstanceOf(SidecarFrameDecodeError);
    await expect(resizeP).rejects.toThrow(/unknown inbound envelope kind "future_unknown_kind"/);

    const resizeErr: unknown = await resizeP.catch((e: unknown) => e);
    expect(resizeErr).toBeInstanceOf(SidecarFrameDecodeError);
    if (resizeErr instanceof SidecarFrameDecodeError) {
      expect(resizeErr.decodeCause).toBe("unknown-kind");
    }
  });

  it("(c) unknown envelope kind with non-string kind field still triggers fatal teardown", async () => {
    // A sidecar bug may send `{"kind": 42}` or `{"kind": null}`. No `case` matches, so the
    // `default:` arm tears down; the message uses `<non-string:${typeof}>` to name the observed
    // type without stringifying the raw value.
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

    // The message carries `<non-string:number>`, which tells this apart from an unknown string
    // kind.
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
// A `data_frame.bytes` that is not strict RFC 4648 base64 is fatal like the decode failures
// above (`decodeCause = "invalid-base64"`). `Buffer.from(s, "base64")` silently drops
// out-of-alphabet characters and tolerates bad padding, so without strict validation consumers
// would get a corrupted byte stream. Two cases: an out-of-alphabet character (`"AAA@"`, right
// length, fails the regex) and a length that is not a multiple of 4 (`"abc"`, fails the length
// check). `onData` must never fire.
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

    // Register the spy before the frame lands so "never called" means something.
    const onDataSpy = vi.fn();
    host.setOnData(onDataSpy);

    // Validation runs before the alive, closed and unknown-session routing. The alive path is the
    // strictest case because it is the one that would dispatch to `onData`.
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

    // A 4-character `bytes` passes the length check and has an out-of-alphabet `@`.
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

    // (i) SIGKILL, as on the earlier paths.
    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;
    expect(killMock).toHaveBeenCalledWith("SIGKILL");

    // (ii) Load-bearing: `onData` never fired. `Buffer.from("AAA@", "base64")` would silently
    // drop the `@` and deliver a corrupted prefix.
    expect(onDataSpy).not.toHaveBeenCalled();

    // The exit event makes the supervisor charge the budget and run teardown.
    clock.mockReturnValue(100);
    seq.latest().triggerExit(137, "SIGKILL");
    await flushMicrotasks();

    // (iii) The outstanding promise rejects with decodeCause 'invalid-base64'.
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

    const writeP = host.write("s-0", new Uint8Array([0x68, 0x69])); // "hi"
    await flushMicrotasks();

    // A 3-character `bytes` fails the length check before the regex runs.
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

    // Load-bearing: `onData` never fired. `Buffer.from("abc", "base64")` would silently yield 2
    // bytes.
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
