// `RustSidecarPtyHost` against a fake sidecar child: framing, crash budget and respawn, and
// teardown. Crash-budget tests inject a clock so the sliding window is deterministic.

import { Buffer } from "node:buffer";

import { PTY_BACKEND_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import { RustSidecarPtyHost } from "../rust-sidecar-pty-host.js";
import {
  CRASH_BUDGET_LIMIT,
  CRASH_BUDGET_WINDOW_MS,
  type SidecarSpawnFn,
} from "../sidecar-child-supervisor.js";
import { MAX_FRAME_BODY_BYTES, SidecarFrameDecodeError } from "../sidecar-frame-codec.js";
import { PtyBackendUnavailableError } from "../sidecar-binary-path.js";
import {
  type FakeSidecarChild,
  flushMicrotasks,
  frameEnvelope,
  makeFakeSidecarChild,
  parseFramesFromStdin,
  spawnReturning,
} from "./pty-host.test-support.js";
import { captureRejection } from "../../workspace/__tests__/workspace.test-support.js";

/**
 * Stub `SidecarSpawnFn` that returns a fresh fake on each call, for crash-respawn tests;
 * `latest` returns the most recently spawned fake.
 */
function spawnReturningSequence(): {
  spawn: SidecarSpawnFn;
  latest: () => FakeSidecarChild;
  spawned: () => readonly FakeSidecarChild[];
} {
  const fakes: FakeSidecarChild[] = [];
  const spawn: SidecarSpawnFn = vi.fn<SidecarSpawnFn>().mockImplementation(() => {
    const fake = makeFakeSidecarChild();
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

// ----------------------------------------------------------------------------
// Every PtyHost method is implemented.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — PtyHost contract surface", () => {
  it("spawn round-trips through the framer and resolves with the SpawnResponse", async () => {
    const fake = makeFakeSidecarChild();
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

    // The header must be exactly `Content-Length: <n>` and a blank line before the JSON body.
    expect(fake.readStdin().toString("utf8")).toMatch(/^Content-Length: \d+\r\n\r\n\{/);
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

  it("resize, write (base64) and kill send their requests and resolve on the responses", async () => {
    const fake = makeFakeSidecarChild();
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

    const resizePromise = host.resize("s-0", 30, 100);
    await flushMicrotasks();
    const resizeFrames = parseFramesFromStdin(fake.readStdin());
    expect(resizeFrames[resizeFrames.length - 1]).toEqual({
      kind: "resize_request",
      session_id: "s-0",
      rows: 30,
      cols: 100,
    });
    fake.writeStdout(frameEnvelope({ kind: "resize_response", session_id: "s-0" }));
    await expect(resizePromise).resolves.toBeUndefined();

    const payload = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    const writeP = host.write("s-0", payload);
    await flushMicrotasks();
    const writeFrames = parseFramesFromStdin(fake.readStdin());
    expect(writeFrames[writeFrames.length - 1]).toEqual({
      kind: "write_request",
      session_id: "s-0",
      // "hello" base64 = "aGVsbG8="
      bytes: "aGVsbG8=",
    });
    fake.writeStdout(frameEnvelope({ kind: "write_response", session_id: "s-0" }));
    await expect(writeP).resolves.toBeUndefined();

    const killP = host.kill("s-0", "SIGTERM");
    await flushMicrotasks();
    const killFrames = parseFramesFromStdin(fake.readStdin());
    expect(killFrames[killFrames.length - 1]).toEqual({
      kind: "kill_request",
      session_id: "s-0",
      signal: "SIGTERM",
    });
    fake.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(killP).resolves.toBeUndefined();
  });

  it("kill() on an exited session fires no second onExit and sends no kill_request", async () => {
    // A kill on an exited child's id could reach a session the sidecar has already dropped.
    const fake = makeFakeSidecarChild();
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
        exit_code: 3,
        signal_code: null,
      }),
    );
    await flushMicrotasks();
    expect(exitFn).toHaveBeenCalledTimes(1);

    // Resolves at once: no request goes out, so no response is awaited.
    await host.kill("s-0", "SIGTERM");

    expect(exitFn).toHaveBeenCalledTimes(1);
    const killRequests = parseFramesFromStdin(fake.readStdin()).filter(
      (envelope) => envelope.kind === "kill_request",
    );
    expect(killRequests).toHaveLength(0);
  });

  it("onData fans out DataFrame chunks to the registered listener (base64-decoded)", async () => {
    const fake = makeFakeSidecarChild();
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
// Sliding-window crash budget.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — sliding-window crash budget", () => {
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
    const thrown = await captureRejection(() =>
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
    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.code).toBe(PTY_BACKEND_UNAVAILABLE_CODE);
      expect(thrown.details.attemptedBackend).toBe("rust-sidecar");
    }
  });

  it("evicts crash entries older than the window", async () => {
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
});

// ----------------------------------------------------------------------------
// The parser is reset on child exit so the next sidecar does not inherit a half-read frame.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — the sidecar's own frame body limit", () => {
  it("waits for the body when a frame declares exactly MAX_FRAME_BODY_BYTES", async () => {
    const seq = spawnReturningSequence();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: () => 0,
    });
    const spawnPromise = host.spawn({
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
    await spawnPromise;
    const killMock = seq.latest().child.kill as ReturnType<typeof vi.fn>;

    // The cap is checked on the declared length, so no body bytes are needed.
    seq.latest().writeStdout(Buffer.from(`Content-Length: ${MAX_FRAME_BODY_BYTES}\r\n\r\n`));
    await flushMicrotasks();
    expect(killMock).not.toHaveBeenCalled();
  });

  it("tears down the child when a frame declares one byte past MAX_FRAME_BODY_BYTES", async () => {
    const seq = spawnReturningSequence();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: () => 0,
    });
    const spawnPromise = host.spawn({
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
    await spawnPromise;

    seq.latest().writeStdout(Buffer.from(`Content-Length: ${MAX_FRAME_BODY_BYTES + 1}\r\n\r\n`));
    await flushMicrotasks();
    expect(seq.latest().child.kill as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("SIGKILL");
  });
});

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
  it("stale stdout from old child does NOT feed the fresh parser after the child exits", async () => {
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
});

describe("RustSidecarPtyHost — wire-side error response rejects awaiting Promise", () => {
  it("kill, write and resize reject with the sidecar's error response instead of hanging", async () => {
    // A request that races the child's natural exit gets a typed error response from the sidecar;
    // the awaiting promise must reject instead of sitting in `outstanding` forever. An explicit
    // kill, not close(): close() logs this error instead of throwing (tested below).
    const fake = makeFakeSidecarChild();
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

  it("rejects host.spawn() on a SpawnResponse error and registers no session for its id", async () => {
    // The promise must reject instead of hanging, and the host must not track a session the
    // sidecar never created, even when the failed response carries a non-empty session_id.
    const fake = makeFakeSidecarChild();
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
    await expect(spawnPromise).rejects.toThrow(
      /sidecar spawn_response returned error.*portable-pty error: command not found/,
    );

    await expect(host.write("s-failed", new Uint8Array([0]))).rejects.toThrow(
      /unknown sessionId 's-failed'/,
    );
  });
});

describe("RustSidecarPtyHost — close() lifecycle", () => {
  it("close() on a live session writes kill_request{SIGTERM} to stdin and resolves on the response", async () => {
    const fake = makeFakeSidecarChild();
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

  it("close() does not throw on a wire-side error response (close races natural exit)", async () => {
    // close() racing the child's natural exit gets a typed error response; close() must not
    // throw on it.
    const fake = makeFakeSidecarChild();
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

  it("close() suppresses onExit for an ExitCodeNotification that arrives after close() resolves", async () => {
    // close() removes the session record synchronously, so the sidecar's late exit notification
    // for it must not reach onExit. NodePtyHost likewise stops reporting exits after close():
    // consumers treat close() as terminal.
    const fake = makeFakeSidecarChild();
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
    const fake = makeFakeSidecarChild();
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
    const fake = makeFakeSidecarChild();
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
  it("delivers same-chunk DataFrame + ExitCodeNotification trailing SpawnResponse for short-lived process", async () => {
    // A short-lived process: the DataFrame and ExitCodeNotification both trail the SpawnResponse
    // in one chunk, and both must reach their listeners.
    const fake = makeFakeSidecarChild();
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

  it("replays a DataFrame and ExitCodeNotification that preceded the SpawnResponse, in wire order, after spawn() resolves", async () => {
    const fake = makeFakeSidecarChild();
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

  it("delivers DataFrame arriving same-chunk BEFORE SpawnResponse, after spawn() resolves", async () => {
    const fake = makeFakeSidecarChild();
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

  it("delivers ExitCodeNotification arriving same-chunk BEFORE SpawnResponse, after spawn() resolves", async () => {
    const fake = makeFakeSidecarChild();
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

  it("survives drain-cycle boundary: DataFrame in chunk N, SpawnResponse in chunk N+1, replay still fires", async () => {
    const fake = makeFakeSidecarChild();
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

  it("clears the pre-spawn buffer on sidecar teardown so pre-crash events do not replay into a respawned session", async () => {
    // The sidecar's session ids (`s-{n}`) restart after a respawn. A pre-crash DataFrame for `s-0`
    // that never got its SpawnResponse must not replay against the new child's `s-0`.
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
    // Crash the first child; its teardown clears the buffer.
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
});

describe("RustSidecarPtyHost — dual error+exit events do not double-charge the crash budget", () => {
  it("emits both 'error' and 'exit' for the same child; budget is consumed exactly once", async () => {
    // Node's `child_process` can emit both `error` and `exit` for one failed child. The
    // stale-child guard and the per-child dedupe (`crashCountedChildren`) each keep the second
    // event from charging the budget; without both, one crash would count twice and the budget
    // would exhaust at half the limit.
    const seq = spawnReturningSequence();
    const clock = vi.fn<() => number>().mockReturnValue(0);
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: seq.spawn,
      nowMs: clock,
    });

    // Crash CRASH_BUDGET_LIMIT - 1 children, each emitting both events. Counted twice, the budget
    // would already be exhausted and the next spawn refused.
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
// child must not touch the new one: it would forget the live child, detach a listener from the
// wrong stream, and reject the new child's pending requests. `SidecarChildSupervisor`'s
// `releaseExitedChild` ignores an event whose child is not the live one.

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
    // twice, or `error` then `exit`). Without the stale-event guard it would forget child B and
    // reject B's pending spawn.
    childA.triggerExit(1, null);
    await flushMicrotasks();

    // B's pending spawn resolves through B's response; the stale event did not reject it.
    childB.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    await expect(spawnP2).resolves.toEqual({ kind: "spawn_response", session_id: "s-1" });
  });

  it("stale 'error' event for an old child after replacement does not clear the new child", async () => {
    // The `error` handler goes through the same stale-event guard as the `exit` handler.
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

    childB.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    await expect(spawnP2).resolves.toEqual({ kind: "spawn_response", session_id: "s-1" });
  });
});

// ----------------------------------------------------------------------------
// Crash-time onExit: when the sidecar dies, every session still in the map gets
// `onExit(sessionId, -1)` and is deleted. A session whose exit already fired is not
// re-fired, a throwing listener does not strand the rest, and a stale event never fires against
// a replacement child's sessions.
// ----------------------------------------------------------------------------

describe("RustSidecarPtyHost — crash-time per-session onExit", () => {
  it("handleChildExit fires onExit(-1) for every active session and empties the session map", async () => {
    const fake = makeFakeSidecarChild();
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
    const fake = makeFakeSidecarChild();
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

  it("does NOT re-fire onExit for a session whose normal-path exit already fired", async () => {
    const fake = makeFakeSidecarChild();
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

    // s-0 exits normally: onExit fires once.
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

    // The crash skips s-0 (its exit already fired) and fires only for s-1; the map is emptied
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
    // Skipping an already-exited session on crash would leave its id in the session map. `resize`
    // and `write` gate only on that map, so the stale id would respawn the sidecar and reach a child
    // that has no record of it, or one whose own `s-0` is another session.
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

    // s-0 exits normally: its exit fires but the record stays in the map (only
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
    const fake = makeFakeSidecarChild();
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
    const internals: { sessions: Map<string, unknown> } = host as unknown as {
      sessions: Map<string, unknown>;
    };
    expect(internals.sessions.has("s-1")).toBe(true);
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
      "RustSidecarPtyHost: sidecar binary not found on any of the four resolution steps. " +
        "Attempts:\n" +
        "  step 1 (env-var SIDEKICKS_PTY_SIDECAR_BIN): unset\n" +
        "  step 2 (require.resolve(...)): threw: Cannot find module\n" +
        "  step 3 (...): not found at /workspace/.../release/sidecar\n" +
        "  step 4 (...): not found at /workspace/.../debug/sidecar\n" +
        "Set SIDEKICKS_PTY_SIDECAR_BIN=...",
    );

    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => {
        throw resolverError;
      },
      // The spawn function must never be reached.
      spawn: vi.fn<SidecarSpawnFn>(),
    });

    const thrown = await captureRejection(() =>
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

    // Same-instance check: a wrapper that carries the original as `details.cause` would fail
    // `.toBe`.
    expect(thrown).toBe(resolverError);
    // A rebuilt error that keeps the same `details.cause` would pass an `instanceof` check, so
    // also assert the message and cause survive.
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toContain("not found on any of the four resolution steps");
      expect(thrown.message).toContain("step 1 (env-var SIDEKICKS_PTY_SIDECAR_BIN): unset");
      expect(thrown.details.cause).toBe(innerCause);
    }
  });

  it("wraps a plain Error from a custom resolver in PtyBackendUnavailableError", async () => {
    // A future widening of the passthrough guard (e.g. to `instanceof Error`) must not let plain
    // errors through without the `attemptedBackend` tag.
    const cause: Error = new Error("custom resolver failure");
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => {
        throw cause;
      },
      spawn: vi.fn<SidecarSpawnFn>(),
    });

    const thrown = await captureRejection(() =>
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
    const fake = makeFakeSidecarChild();
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
    const fake = makeFakeSidecarChild();
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
    // and charges the crash budget once.
    const firstThrown = await captureRejection(() =>
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

    // Check the budget was charged once, through the sliding window: after one charge the host
    // tolerates `CRASH_BUDGET_LIMIT - 1` more synchronous failures. The live sidecar must exit
    // first so the next request spawns fresh; that exit is a crash and charges the budget again.
    fake.triggerExit(1, null);
    await flushMicrotasks();

    // Every later spawn throws ENOENT and charges the budget.
    spawnFn.mockImplementation(() => {
      const e = new Error("ENOENT") as Error & { code?: string };
      e.code = "ENOENT";
      throw e;
    });

    // Two charges are spent (the first ENOENT plus the sidecar exit), so `CRASH_BUDGET_LIMIT - 2`
    // more failures reach the limit and the last one exhausts the budget. A double charge on the
    // first failure would exhaust it one iteration early.
    for (let i = 0; i < CRASH_BUDGET_LIMIT - 2; i += 1) {
      clock.mockReturnValue(2000 + i * 1000);
      const caught = await captureRejection(() =>
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
      expect(caught).toBeInstanceOf(PtyBackendUnavailableError);
      // These are per-spawn ENOENT wraps; the budget-exhausted message appears only on the call
      // after the limit is reached.
      if (caught instanceof PtyBackendUnavailableError) {
        expect(caught.message).not.toMatch(/crash-respawn budget exhausted/);
      }
    }

    // The next request must report budget exhaustion; a double charge would do so a cycle earlier.
    clock.mockReturnValue(2000 + CRASH_BUDGET_LIMIT * 1000);
    const exhaustedThrown = await captureRejection(() =>
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
      // the test finished and a missing handler would go unseen. Vitest installs its own handler,
      // but that can be configured away.
      const uncaught: Error[] = [];
      const captureUncaught = (err: Error): void => {
        uncaught.push(err);
      };
      process.on("uncaughtException", captureUncaught);

      try {
        const fake = makeFakeSidecarChild();
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
//   `{garbage`          JSON.parse throws: "json-parse".
//   `null`              valid JSON but not an object envelope: "non-object-envelope".
//   `{"kind":"future"}` an object whose `kind` matches no `Envelope` variant (version skew or a
//                       sidecar bug): "unknown-kind".
// ----------------------------------------------------------------------------

/**
 * Frames a raw string body as a Content-Length frame, for payloads `frameEnvelope` cannot
 * produce (invalid JSON, `null`, an unknown kind).
 */
function frameRawBody(rawBody: string): Buffer {
  const payload: Buffer = Buffer.from(rawBody, "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

describe("RustSidecarPtyHost — fatal teardown on JSON-decode failure", () => {
  it("malformed JSON body `{garbage` SIGKILLs the child, rejects every outstanding request with SidecarFrameDecodeError(cause='json-parse'), and respawns on the next request", async () => {
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

  it("JSON-valid but non-object payload (`null`) SIGKILLs the child and rejects outstanding with SidecarFrameDecodeError(cause='non-object-envelope')", async () => {
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

  it("unknown envelope kind triggers fatal teardown with decodeCause='unknown-kind'", async () => {
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
  it("data_frame.bytes with an invalid-alphabet character SIGKILLs the child, does NOT fire onData, and rejects outstanding with SidecarFrameDecodeError(cause='invalid-base64')", async () => {
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

  it("data_frame.bytes with bad padding (length not multiple of 4) SIGKILLs the child, does NOT fire onData, and rejects outstanding with SidecarFrameDecodeError(cause='invalid-base64')", async () => {
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
