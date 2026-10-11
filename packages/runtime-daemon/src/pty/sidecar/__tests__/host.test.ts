// `RustSidecarPtyHost` against fake sidecar children: the request wire, exit reporting, crash
// supervision and respawn, and the fatal teardown on output the host cannot trust. The crash
// budget reads an injected clock so its sliding window is deterministic.

import { Buffer } from "node:buffer";

import { describe, expect, it, type Mock, onTestFinished, vi } from "vitest";

import { RustSidecarPtyHost } from "../host.js";
import { PtyBackendUnavailableError } from "../binary-path.js";
import {
  CRASH_BUDGET_LIMIT,
  CRASH_BUDGET_WINDOW_MS,
  type SidecarSpawnFn,
} from "../child-supervisor.js";
import { MAX_FRAME_BODY_BYTES } from "../frame-codec.js";
import {
  type FakeSidecarChild,
  flushMicrotasks,
  frameEnvelope,
  makeFakeSidecarChild,
  parseFramesFromStdin,
  SHELL_SPAWN_REQUEST,
  spawnAnsweredSession,
} from "../../__fixtures__/child-doubles.js";

interface HostUnderTest {
  readonly host: RustSidecarPtyHost;
  /** Every sidecar child the host has spawned, oldest first. */
  readonly children: readonly FakeSidecarChild[];
  readonly latestChild: () => FakeSidecarChild;
  /** The crash budget's clock in milliseconds; it reads 0 until a test moves it. */
  readonly clock: Mock<() => number>;
}

/** A host whose every sidecar spawn returns a fresh fake child. */
function makeHost(): HostUnderTest {
  const children: FakeSidecarChild[] = [];
  const clock = vi.fn<() => number>().mockReturnValue(0);
  const host = new RustSidecarPtyHost({
    resolveBinaryPath: () => "/fake/sidecar",
    spawn: () => {
      const child = makeFakeSidecarChild();
      children.push(child);
      return child.child as unknown as ReturnType<SidecarSpawnFn>;
    },
    nowMs: clock,
  });
  const latestChild = (): FakeSidecarChild => {
    const child = children[children.length - 1];
    if (child === undefined) {
      throw new Error("no sidecar child has been spawned yet");
    }
    return child;
  };
  return { host, children, latestChild, clock };
}

/** Starts a spawn and crashes the sidecar before it answers. */
async function crashDuringSpawn(
  subject: HostUnderTest,
  crash: (child: FakeSidecarChild) => void,
): Promise<void> {
  const spawning = subject.host.spawn(SHELL_SPAWN_REQUEST);
  await flushMicrotasks();
  crash(subject.latestChild());
  await expect(spawning).rejects.toThrow();
}

function lastFrameSentTo(child: FakeSidecarChild): unknown {
  const frames = parseFramesFromStdin(child.readStdin());
  return frames[frames.length - 1];
}

function exitNotification(sessionId: string, exitCode: number): Buffer {
  return frameEnvelope({
    kind: "exit_code_notification",
    session_id: sessionId,
    exit_code: exitCode,
    signal_code: null,
  });
}

function dataFrame(sessionId: string, text: string): Buffer {
  return frameEnvelope({
    kind: "data_frame",
    session_id: sessionId,
    stream: "stdout",
    seq: 0,
    bytes: Buffer.from(text, "utf8").toString("base64"),
  });
}

/** Frames a raw body, for payloads `frameEnvelope` cannot express. */
function frameRawBody(rawBody: string): Buffer {
  const payload = Buffer.from(rawBody, "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload]);
}

/** Waits one I/O turn, so events the host releases with `setImmediate` have fired. */
async function flushSetImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

const SIDECAR_CRASHES = [
  {
    event: "exit",
    crash: (child: FakeSidecarChild): void => {
      child.triggerExit(1, null);
    },
  },
  {
    event: "error",
    crash: (child: FakeSidecarChild): void => {
      child.triggerError(new Error("sidecar crashed"));
    },
  },
];

describe("RustSidecarPtyHost — request wire", () => {
  it("frames each request, resolves it on its response, and decodes output", async () => {
    const subject = makeHost();
    const { host } = subject;
    const output = vi.fn();
    host.setOnData(output);

    const spawning = host.spawn({ ...SHELL_SPAWN_REQUEST, args: ["-c", "echo hi"] });
    await flushMicrotasks();
    const child = subject.latestChild();
    // The sidecar reads exactly this header before the JSON body.
    expect(child.readStdin().toString("utf8")).toMatch(/^Content-Length: \d+\r\n\r\n\{/);
    expect(lastFrameSentTo(child)).toMatchObject({ command: "/bin/sh", args: ["-c", "echo hi"] });
    child.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await expect(spawning).resolves.toEqual({ kind: "spawn_response", session_id: "s-0" });

    const resizing = host.resize("s-0", 30, 100);
    await flushMicrotasks();
    expect(lastFrameSentTo(child)).toEqual({
      kind: "resize_request",
      session_id: "s-0",
      rows: 30,
      cols: 100,
    });
    child.writeStdout(frameEnvelope({ kind: "resize_response", session_id: "s-0" }));
    await expect(resizing).resolves.toBeUndefined();

    const writing = host.write("s-0", Buffer.from("hello", "utf8"));
    await flushMicrotasks();
    expect(lastFrameSentTo(child)).toEqual({
      kind: "write_request",
      session_id: "s-0",
      bytes: "aGVsbG8=",
    });
    child.writeStdout(frameEnvelope({ kind: "write_response", session_id: "s-0" }));
    await expect(writing).resolves.toBeUndefined();

    const killing = host.kill("s-0", "SIGTERM");
    await flushMicrotasks();
    expect(lastFrameSentTo(child)).toEqual({
      kind: "kill_request",
      session_id: "s-0",
      signal: "SIGTERM",
    });
    child.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    await expect(killing).resolves.toBeUndefined();

    child.writeStdout(dataFrame("s-0", "world"));
    await flushMicrotasks();
    expect(output).toHaveBeenCalledTimes(1);
    const [sessionId, chunk] = output.mock.calls[0]!;
    expect(sessionId).toBe("s-0");
    expect(Buffer.from(chunk).toString("utf8")).toBe("world");
  });

  it(
    "rejects a request the sidecar answers with an error, and tracks no session for a failed " +
      "spawn",
    async () => {
      const subject = makeHost();
      const { host } = subject;

      const failedSpawn = host.spawn(SHELL_SPAWN_REQUEST);
      await flushMicrotasks();
      const child = subject.latestChild();
      child.writeStdout(
        frameEnvelope({
          kind: "spawn_response",
          session_id: "s-failed",
          error: "command not found",
        }),
      );
      await expect(failedSpawn).rejects.toThrow("command not found");
      await expect(host.write("s-failed", new Uint8Array([0]))).rejects.toThrow(
        "unknown sessionId 's-failed'",
      );

      // A request racing the process's own exit gets an error response; it must not hang.
      await spawnAnsweredSession(subject.host, subject.latestChild, "s-0");
      const killing = host.kill("s-0", "SIGKILL");
      await flushMicrotasks();
      child.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0", error: "gone" }));
      await expect(killing).rejects.toThrow("gone");

      const writing = host.write("s-0", new Uint8Array([1]));
      await flushMicrotasks();
      child.writeStdout(
        frameEnvelope({ kind: "write_response", session_id: "s-0", error: "gone" }),
      );
      await expect(writing).rejects.toThrow("gone");

      const resizing = host.resize("s-0", 30, 100);
      await flushMicrotasks();
      child.writeStdout(
        frameEnvelope({ kind: "resize_response", session_id: "s-0", error: "gone" }),
      );
      await expect(resizing).rejects.toThrow("gone");
    },
  );

  it(
    "close() SIGTERMs the session and reports nothing for it afterwards, whatever the sidecar " +
      "answers",
    async () => {
      const subject = makeHost();
      const { host } = subject;
      const output = vi.fn();
      const exits = vi.fn();
      host.setOnData(output);
      host.setOnExit(exits);
      await spawnAnsweredSession(subject.host, subject.latestChild, "s-0");
      const child = subject.latestChild();
      const sentBeforeClose = child.readStdin().length;

      const closing = host.close("s-0");
      await flushMicrotasks();
      expect(parseFramesFromStdin(child.readStdin().subarray(sentBeforeClose))).toEqual([
        { kind: "kill_request", session_id: "s-0", signal: "SIGTERM" },
      ]);

      // The exit can reach the wire before the kill response, and the response is an error when
      // close() races the process's own exit; neither may reach the caller.
      child.writeStdout(exitNotification("s-0", 137));
      await flushMicrotasks();
      child.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0", error: "gone" }));
      await expect(closing).resolves.toBeUndefined();

      child.writeStdout(Buffer.concat([exitNotification("s-0", 137), dataFrame("s-0", "late")]));
      await flushMicrotasks();
      expect(exits).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
    },
  );

  it("close() kills a session that outlives its SIGTERM, and throws when it outlives that", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const subject = makeHost();
    await spawnAnsweredSession(subject.host, subject.latestChild, "s-0");
    const child = subject.latestChild();
    const sentBeforeClose = child.readStdin().length;
    const answerKill = async (): Promise<void> => {
      await flushMicrotasks();
      child.writeStdout(frameEnvelope({ kind: "kill_response", session_id: "s-0" }));
    };

    const closing = subject.host.close("s-0");
    const refusal = expect(closing).rejects.toThrow("s-0's child did not end when killed");
    await answerKill();
    await vi.advanceTimersByTimeAsync(2_000);
    await answerKill();
    await vi.advanceTimersByTimeAsync(2_000);

    await refusal;
    expect(parseFramesFromStdin(child.readStdin().subarray(sentBeforeClose))).toEqual([
      { kind: "kill_request", session_id: "s-0", signal: "SIGTERM" },
      { kind: "kill_request", session_id: "s-0", signal: "SIGKILL" },
    ]);
  });
});

describe("RustSidecarPtyHost — sidecar crash", () => {
  it.each(SIDECAR_CRASHES)(
    "on $event ends every live session exactly once and forgets every id",
    async ({ crash }) => {
      const subject = makeHost();
      const { host } = subject;
      // A listener that throws for one session must not strand the sessions after it.
      const exits = vi.fn().mockImplementation((sessionId: string) => {
        if (sessionId === "s-1") {
          throw new Error("listener bug");
        }
      });
      host.setOnExit(exits);
      for (const sessionId of ["s-0", "s-1", "s-2"]) {
        await spawnAnsweredSession(subject.host, subject.latestChild, sessionId);
      }
      const child = subject.latestChild();

      // s-0 ends on its own; a later kill must not signal a session the sidecar has dropped.
      child.writeStdout(exitNotification("s-0", 0));
      await flushMicrotasks();
      await host.kill("s-0", "SIGTERM");
      const killRequests = parseFramesFromStdin(child.readStdin()).filter(
        (envelope) => envelope.kind === "kill_request",
      );
      expect(killRequests).toEqual([]);

      crash(child);
      await flushMicrotasks();

      expect(exits.mock.calls).toEqual([
        ["s-0", 0],
        ["s-1", -1],
        ["s-2", -1],
      ]);
      // A remembered id would respawn the sidecar and reach a child whose own s-0 is another
      // session.
      for (const sessionId of ["s-0", "s-1", "s-2"]) {
        await expect(host.write(sessionId, new Uint8Array([0x68]))).rejects.toThrow(
          `unknown sessionId '${sessionId}'`,
        );
      }
      expect(subject.children).toHaveLength(1);
    },
  );

  // Node can report one failed child twice (`exit` twice, or `error` then `exit`).
  it.each(SIDECAR_CRASHES)("ignores a late $event from a replaced sidecar", async ({ crash }) => {
    const subject = makeHost();
    const { host } = subject;
    const exits = vi.fn();
    host.setOnExit(exits);
    await spawnAnsweredSession(subject.host, subject.latestChild, "s-0");
    const oldChild = subject.latestChild();
    crash(oldChild);
    await flushMicrotasks();

    const respawning = host.spawn(SHELL_SPAWN_REQUEST);
    await flushMicrotasks();
    const newChild = subject.latestChild();
    crash(oldChild);
    await flushMicrotasks();
    newChild.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-1" }));
    await expect(respawning).resolves.toEqual({ kind: "spawn_response", session_id: "s-1" });

    crash(oldChild);
    await flushMicrotasks();
    expect(exits.mock.calls).toEqual([["s-0", -1]]);
    const resizing = host.resize("s-1", 30, 100);
    await flushMicrotasks();
    expect(lastFrameSentTo(newChild)).toMatchObject({ kind: "resize_request", session_id: "s-1" });
    newChild.writeStdout(frameEnvelope({ kind: "resize_response", session_id: "s-1" }));
    await expect(resizing).resolves.toBeUndefined();
    expect(subject.children).toHaveLength(2);
  });

  it("a respawned sidecar gets a fresh parser; the old one's late output is ignored", async () => {
    const subject = makeHost();
    await spawnAnsweredSession(subject.host, subject.latestChild, "s-0");
    const oldChild = subject.latestChild();
    // A half-read header left in the parser would garble every frame the next sidecar sends.
    oldChild.writeStdout(Buffer.from("Content-Length: 27\r", "utf8"));
    await flushMicrotasks();
    oldChild.triggerExit(1, null);
    await flushMicrotasks();

    const respawning = subject.host.spawn(SHELL_SPAWN_REQUEST);
    await flushMicrotasks();
    oldChild.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-stale" }));
    await flushMicrotasks();
    subject
      .latestChild()
      .writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-fresh" }));
    await expect(respawning).resolves.toEqual({ kind: "spawn_response", session_id: "s-fresh" });
  });

  // A pipe error is emitted as an 'error' event; with no listener it would throw out of the
  // stream and take the daemon down.
  it.each(["stdin", "stdout", "stderr"] as const)(
    "absorbs an error on the sidecar's %s and stops the sidecar",
    async (stream) => {
      const subject = makeHost();
      const spawning = subject.host.spawn(SHELL_SPAWN_REQUEST);
      await flushMicrotasks();
      const child = subject.latestChild();

      child.child[stream].emit("error", new Error("write EPIPE"));

      expect(child.child.kill).toHaveBeenCalledWith("SIGTERM");
      child.triggerExit(null, "SIGTERM");
      await expect(spawning).rejects.toThrow("sidecar exited");
    },
  );
});

describe("RustSidecarPtyHost — crash budget", () => {
  it.each([
    SIDECAR_CRASHES[0]!,
    {
      event: "error then exit",
      crash: (child: FakeSidecarChild): void => {
        child.triggerError(new Error("sidecar crashed"));
        child.triggerExit(1, null);
      },
    },
  ])(
    "respawns after each crash below the limit and refuses after the last (crash as $event)",
    async ({ crash }) => {
      const subject = makeHost();
      for (let i = 0; i < CRASH_BUDGET_LIMIT; i += 1) {
        subject.clock.mockReturnValue(i * 1000);
        await crashDuringSpawn(subject, crash);
      }
      // One child per crash: a crash Node reports twice is charged once.
      expect(subject.children).toHaveLength(CRASH_BUDGET_LIMIT);

      subject.clock.mockReturnValue(CRASH_BUDGET_LIMIT * 1000);
      await expect(subject.host.spawn(SHELL_SPAWN_REQUEST)).rejects.toBeInstanceOf(
        PtyBackendUnavailableError,
      );
      expect(subject.children).toHaveLength(CRASH_BUDGET_LIMIT);
    },
  );

  it("forgets crashes older than the window", async () => {
    const subject = makeHost();
    const exitCrash = SIDECAR_CRASHES[0]!.crash;
    for (let i = 0; i < CRASH_BUDGET_LIMIT - 1; i += 1) {
      subject.clock.mockReturnValue(i * 1000);
      await crashDuringSpawn(subject, exitCrash);
    }
    // Counted with the earlier crashes, this one would spend the budget.
    subject.clock.mockReturnValue(CRASH_BUDGET_WINDOW_MS + 5000);
    await crashDuringSpawn(subject, exitCrash);

    subject.clock.mockReturnValue(CRASH_BUDGET_WINDOW_MS + 6000);
    void subject.host.spawn(SHELL_SPAWN_REQUEST);
    await flushMicrotasks();
    expect(subject.children).toHaveLength(CRASH_BUDGET_LIMIT + 1);
  });

  it("retries a spawn that failed synchronously and charges each failure once", async () => {
    // A cold-start latch left set by a failure would report that failure forever.
    const spawn = vi.fn<SidecarSpawnFn>().mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn,
      nowMs: () => 0,
    });
    for (let i = 0; i < CRASH_BUDGET_LIMIT; i += 1) {
      await expect(host.spawn(SHELL_SPAWN_REQUEST)).rejects.toBeInstanceOf(
        PtyBackendUnavailableError,
      );
      expect(spawn).toHaveBeenCalledTimes(i + 1);
    }
    await expect(host.spawn(SHELL_SPAWN_REQUEST)).rejects.toBeInstanceOf(
      PtyBackendUnavailableError,
    );
    expect(spawn).toHaveBeenCalledTimes(CRASH_BUDGET_LIMIT);
  });

  it("starts one sidecar for concurrent first requests", async () => {
    // A sidecar per caller would orphan all but the last.
    const subject = makeHost();
    const spawns = Array.from({ length: 5 }, () => subject.host.spawn(SHELL_SPAWN_REQUEST));
    await flushMicrotasks();
    for (let i = 0; i < 5; i += 1) {
      subject
        .latestChild()
        .writeStdout(frameEnvelope({ kind: "spawn_response", session_id: `s-${i}` }));
    }
    await expect(Promise.all(spawns)).resolves.toHaveLength(5);
    expect(subject.children).toHaveLength(1);
  });

  it("rejects spawn with PtyBackendUnavailableError when the binary cannot resolve", async () => {
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => {
        throw new Error("custom resolver failure");
      },
      spawn: vi.fn<SidecarSpawnFn>(),
    });
    await expect(host.spawn(SHELL_SPAWN_REQUEST)).rejects.toBeInstanceOf(
      PtyBackendUnavailableError,
    );
  });
});

describe("RustSidecarPtyHost — output the host cannot trust", () => {
  it("waits for the body of a frame declaring exactly the size limit", async () => {
    const subject = makeHost();
    await spawnAnsweredSession(subject.host, subject.latestChild, "s-0");
    subject
      .latestChild()
      .writeStdout(Buffer.from(`Content-Length: ${MAX_FRAME_BODY_BYTES}\r\n\r\n`));
    await flushMicrotasks();
    expect(subject.latestChild().child.kill).not.toHaveBeenCalled();
  });

  // Skipping such a frame would leave its request pending forever, and decoding it leniently would
  // hand consumers corrupted terminal output.
  it.each([
    {
      label: "a declared length over the limit",
      bytes: Buffer.from(`Content-Length: ${MAX_FRAME_BODY_BYTES + 1}\r\n\r\n`),
      decodeCause: null,
    },
    {
      label: "a non-numeric Content-Length",
      bytes: Buffer.from("Content-Length: NOT_A_NUMBER\r\n\r\n"),
      decodeCause: null,
    },
    {
      label: "a body that is not JSON",
      bytes: frameRawBody("{garbage"),
      decodeCause: "json-parse",
    },
    {
      label: "a JSON body that is not an object",
      bytes: frameRawBody("null"),
      decodeCause: "non-object-envelope",
    },
    {
      label: "an unknown envelope kind",
      bytes: frameRawBody(JSON.stringify({ kind: "future_unknown_kind", session_id: "s-0" })),
      decodeCause: "unknown-kind",
    },
    {
      label: "output outside the base64 alphabet",
      bytes: frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: "AAA@",
      }),
      decodeCause: "invalid-base64",
    },
    {
      label: "output with a base64 length that is not a multiple of 4",
      bytes: frameEnvelope({
        kind: "data_frame",
        session_id: "s-0",
        stream: "stdout",
        seq: 0,
        bytes: "abc",
      }),
      decodeCause: "invalid-base64",
    },
  ])(
    "kills the sidecar on $label and fails every pending request",
    async ({ bytes, decodeCause }) => {
      const subject = makeHost();
      const { host } = subject;
      const output = vi.fn();
      host.setOnData(output);
      await spawnAnsweredSession(subject.host, subject.latestChild, "s-0");
      const child = subject.latestChild();
      const resizing = host.resize("s-0", 30, 100);
      const writing = host.write("s-0", new Uint8Array([0x68, 0x69]));
      await flushMicrotasks();

      child.writeStdout(bytes);
      await flushMicrotasks();
      expect(child.child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(output).not.toHaveBeenCalled();

      child.triggerExit(137, "SIGKILL");
      const rejection =
        decodeCause === null ? expect.any(Error) : expect.objectContaining({ decodeCause });
      await expect(resizing).rejects.toEqual(rejection);
      await expect(writing).rejects.toEqual(rejection);
    },
  );
});

// The sidecar starts reading a process's output before it queues the SpawnResponse and writes
// its channels in any order, so a short-lived process's output and exit can land before or after
// that response. None of it may be lost.
describe("RustSidecarPtyHost — output racing the spawn response", () => {
  const spawnResponse = frameEnvelope({ kind: "spawn_response", session_id: "s-0" });

  function recordEvents(host: RustSidecarPtyHost): string[] {
    const events: string[] = [];
    host.setOnData((sessionId, bytes) => {
      events.push(`data ${sessionId} ${Buffer.from(bytes).toString("utf8")}`);
    });
    host.setOnExit((sessionId, exitCode) => {
      events.push(`exit ${sessionId} ${exitCode}`);
    });
    return events;
  }

  it("delivers output and exit that follow the response in its chunk", async () => {
    const subject = makeHost();
    const events = recordEvents(subject.host);
    const spawning = subject.host.spawn(SHELL_SPAWN_REQUEST);
    await flushMicrotasks();
    subject
      .latestChild()
      .writeStdout(
        Buffer.concat([spawnResponse, dataFrame("s-0", "hi"), exitNotification("s-0", 0)]),
      );
    await spawning;
    expect(events).toEqual(["data s-0 hi", "exit s-0 0"]);
  });

  it.each([
    { arrival: "in the response's chunk", chunks: [["data", "exit", "spawn"]] },
    { arrival: "in an earlier chunk", chunks: [["data", "exit"], ["spawn"]] },
  ])(
    "releases buffered output and exit that arrived before the response ($arrival), " +
      "after spawn() resolves",
    async ({ chunks }) => {
      const frames: Record<string, Buffer> = {
        data: dataFrame("s-0", "hi"),
        exit: exitNotification("s-0", 0),
        spawn: spawnResponse,
      };
      const subject = makeHost();
      const events = recordEvents(subject.host);
      const spawning = subject.host.spawn(SHELL_SPAWN_REQUEST);
      await flushMicrotasks();
      for (const chunk of chunks) {
        subject.latestChild().writeStdout(Buffer.concat(chunk.map((name) => frames[name]!)));
        await flushMicrotasks();
      }
      await spawning;
      events.push("spawn resolved");
      await flushSetImmediate();

      // The caller records the session id when spawn() resolves; an event before that is dropped.
      expect(events).toEqual(["spawn resolved", "data s-0 hi", "exit s-0 0"]);
    },
  );

  it("drops what a crashed sidecar buffered rather than pass it to the respawned one", async () => {
    // Session ids restart at s-0 in a new sidecar, so releasing it would land in a different
    // session.
    const subject = makeHost();
    const events = recordEvents(subject.host);
    const crashedSpawn = subject.host.spawn(SHELL_SPAWN_REQUEST);
    await flushMicrotasks();
    subject
      .latestChild()
      .writeStdout(Buffer.concat([dataFrame("s-0", "STALE"), exitNotification("s-0", 1)]));
    await flushMicrotasks();
    subject.latestChild().triggerExit(1, null);
    await expect(crashedSpawn).rejects.toThrow();

    const respawning = subject.host.spawn(SHELL_SPAWN_REQUEST);
    await flushMicrotasks();
    subject.latestChild().writeStdout(Buffer.concat([spawnResponse, dataFrame("s-0", "FRESH")]));
    await respawning;
    await flushSetImmediate();
    expect(events).toEqual(["data s-0 FRESH"]);
  });
});
