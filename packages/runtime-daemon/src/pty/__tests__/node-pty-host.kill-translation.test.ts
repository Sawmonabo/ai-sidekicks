// Test K1 — Windows kill-translation at `PtyHost.kill` (per I-024-1).
//
// Asserts the Windows-only kill-translation matrix from Plan-024 §Step 8
// (lines 117-122) at the unit-of-behavior layer:
//
//   * `SIGINT` ⇒ `GenerateConsoleCtrlEvent(CTRL_C_EVENT=0, child.pid)`
//      — NEVER routes to `taskkill`; NEVER calls `process.kill`.
//   * `SIGTERM` ⇒ `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT=1, child.pid)`
//      — does NOT escalate before the 2 s budget elapses.
//   * `SIGKILL` ⇒ `taskkill /T /F /PID <pid>` directly
//      — NEVER calls `GenerateConsoleCtrlEvent`.
//   * `SIGHUP`  ⇒ same cascade as `SIGTERM` (Plan-024 §Step 8 does not pin a
//      mapping; we documented the SIGTERM-equivalent choice in `node-pty-host.ts`).
//   * Idempotency clause: a `kill()` invoked after the child has
//      cached its exit-code re-emits `onExit` from cache and does NOT
//      call any FFI.
//
// Why this test runs on every platform — the production code reaches
// the Windows-only FFI / `taskkill` primitives through an injectable
// `Deps` record (`NodePtyHostDeps.generateConsoleCtrlEvent` + `.spawnTaskkill`).
// The test injects `vi.fn()` doubles and forces `Deps.platform = "win32"`.
// No real `kernel32.dll` or `taskkill.exe` is loaded; no real `node-pty`
// is loaded either (the test injects `Deps.ptySpawn` with a stub).
//
// Refs: Plan-024 §Invariants I-024-1; ADR-019 §Decision item 1;
// ADR-019 §Failure Mode Analysis row "kill propagation".

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { NodePtyHost } from "../node-pty-host.js";
import type {
  ConsoleCtrlEvent,
  NodePtyChild,
  NodePtySpawnFn,
  TaskkillResult,
} from "../node-pty-host.js";

import type { SpawnRequest } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Test fixtures — fake `node-pty` child
// ----------------------------------------------------------------------------

/**
 * Build a fake `node-pty` child whose handlers (`onData`, `onExit`)
 * capture the listener so the test can manually trigger an exit (used
 * by the idempotency case). `pid` defaults to 12345 — a number small
 * enough to fit in 32 bits but distinctive in test assertions.
 */
function makeFakeChild(pid: number = 12345): {
  child: NodePtyChild;
  triggerExit: (exitCode: number, signal?: number) => void;
} {
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  const child: NodePtyChild = {
    pid,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener) => {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
  };
  return {
    child,
    triggerExit: (exitCode: number, signal?: number) => {
      if (exitListener === null) {
        throw new Error(
          "makeFakeChild.triggerExit: onExit listener not yet attached " +
            "(was the child spawned via NodePtyHost.spawn?)",
        );
      }
      const event: { exitCode: number; signal?: number } =
        signal === undefined ? { exitCode } : { exitCode, signal };
      exitListener(event);
    },
  };
}

const SAMPLE_SPAWN: SpawnRequest = {
  kind: "spawn_request",
  command: "cmd.exe",
  args: ["/c", "echo hello"],
  env: [],
  cwd: "C:\\daemon-stable-parent",
  rows: 24,
  cols: 80,
};

// ----------------------------------------------------------------------------
// Test K1 fixtures — per-`it` host + recorded mocks
// ----------------------------------------------------------------------------

interface KillTranslationCtx {
  host: NodePtyHost;
  child: NodePtyChild;
  triggerExit: (exitCode: number, signal?: number) => void;
  mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void>;
  mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>>;
  ptySpawnStub: Mock<NodePtySpawnFn>;
}

let ctx: KillTranslationCtx;

beforeEach(() => {
  const { child, triggerExit } = makeFakeChild();
  const mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void> = vi.fn();
  const mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
    .fn<(pid: number) => Promise<TaskkillResult>>()
    .mockResolvedValue({ exitCode: 0 });
  const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);

  const host = new NodePtyHost({
    platform: "win32",
    ptySpawn: ptySpawnStub,
    generateConsoleCtrlEvent: mockGCCE,
    spawnTaskkill: mockTaskkill,
  });

  ctx = {
    host,
    child,
    triggerExit,
    mockGCCE,
    mockTaskkill,
    ptySpawnStub,
  };
});

// ----------------------------------------------------------------------------
// Per-signal assertions
// ----------------------------------------------------------------------------

describe("NodePtyHost — Windows kill-translation (I-024-1)", () => {
  it("SIGINT invokes GenerateConsoleCtrlEvent(CTRL_C_EVENT=0, child.pid) and does NOT call taskkill", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGINT");

    // Load-bearing assertion: I-024-1 — SIGINT MUST translate to
    // `CTRL_C_EVENT=0` (NOT `CTRL_BREAK_EVENT=1`, NOT `process.kill`).
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockGCCE).toHaveBeenCalledWith(0, 12345);

    // Negative: SIGINT MUST NOT touch the hard-stop path.
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // Negative: the daemon path MUST NOT delegate to node-pty's own
    // `kill()` on Windows — that's the `microsoft/node-pty#167` bug
    // that I-024-1 explicitly routes around.
    expect(ctx.child.kill).not.toHaveBeenCalled();
  });

  it("SIGTERM invokes GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT=1, child.pid) and does not immediately escalate", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGTERM");

    // SIGTERM kicks the graceful CTRL_BREAK_EVENT first.
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, 12345);

    // Pre-budget: taskkill MUST NOT fire (the 2 s timer is still
    // pending; this is the load-bearing graceful-first semantic for
    // I-024-1's "SIGTERM hard-stop → CTRL_BREAK_EVENT first").
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    expect(ctx.child.kill).not.toHaveBeenCalled();
  });

  it("SIGKILL invokes taskkill directly and skips GenerateConsoleCtrlEvent", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGKILL");

    // SIGKILL is immediate hard-stop — no graceful CTRL_BREAK_EVENT
    // first per Plan-024 §Step 8 line 120.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(12345);

    // Negative: SIGKILL must NOT route through CTRL_BREAK_EVENT or
    // CTRL_C_EVENT — the brief explicitly states "skipping
    // CTRL_BREAK_EVENT".
    expect(ctx.mockGCCE).not.toHaveBeenCalled();
    expect(ctx.child.kill).not.toHaveBeenCalled();
  });

  it("SIGHUP invokes GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT=1, child.pid) per documented SIGTERM-equivalent mapping", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGHUP");

    // Plan-024 §Step 8 does not pin a SIGHUP-on-Windows mapping.
    // `node-pty-host.ts` documents the SIGTERM-equivalent choice
    // (graceful-then-force) — verify the documented behavior so a
    // future change to the mapping breaks this test deliberately.
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, 12345);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Idempotency — kill after the child has already exited
// ----------------------------------------------------------------------------

describe("NodePtyHost — idempotency of kill after child exit (Plan-024:122)", () => {
  it("kill() on an already-exited session re-emits onExit from cache and does NOT call any FFI", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // Register an exit listener so we can observe the re-emit.
    const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
      vi.fn();
    ctx.host.setOnExit(exitRecorder);

    // Simulate the child exiting on its own (the `onExit` subscription
    // attached during `spawn()` captures the exit code into the
    // session record's cache).
    ctx.triggerExit(0);

    // First emission: from the node-pty child's onExit subscription.
    expect(exitRecorder).toHaveBeenCalledTimes(1);
    expect(exitRecorder).toHaveBeenCalledWith(session_id, 0);

    // Now kill() — the idempotency clause: re-emit from cache, NOT
    // touch FFI, NOT throw.
    await ctx.host.kill(session_id, "SIGTERM");

    // Re-emission from cache: total of 2 onExit fires (one from
    // node-pty's own exit + one from kill's idempotency re-emit).
    expect(exitRecorder).toHaveBeenCalledTimes(2);
    expect(exitRecorder).toHaveBeenNthCalledWith(2, session_id, 0);

    // Negative — load-bearing: no FFI invocation, no taskkill, no
    // node-pty kill.
    expect(ctx.mockGCCE).not.toHaveBeenCalled();
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    expect(ctx.child.kill).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Non-Windows pass-through — sanity check
// ----------------------------------------------------------------------------

describe("NodePtyHost — non-Windows kill is a pass-through to node-pty.kill", () => {
  it("on platform=linux, SIGINT delegates to child.kill('SIGINT')", async () => {
    const { child } = makeFakeChild();
    const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
    const host = new NodePtyHost({
      platform: "linux",
      ptySpawn: ptySpawnStub,
    });

    const { session_id } = await host.spawn(SAMPLE_SPAWN);
    await host.kill(session_id, "SIGINT");

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
  });

  it("on platform=darwin, SIGTERM delegates to child.kill('SIGTERM')", async () => {
    const { child } = makeFakeChild();
    const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
    const host = new NodePtyHost({
      platform: "darwin",
      ptySpawn: ptySpawnStub,
    });

    const { session_id } = await host.spawn(SAMPLE_SPAWN);
    await host.kill(session_id, "SIGTERM");

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

// ----------------------------------------------------------------------------
// Spawn round-trip — `spawn/resize/write` happy path
// ----------------------------------------------------------------------------

describe("NodePtyHost — spawn/resize/write round-trip on the host platform", () => {
  it("returns a SpawnResponse with a non-empty session_id", async () => {
    const response = await ctx.host.spawn(SAMPLE_SPAWN);
    expect(response.kind).toBe("spawn_response");
    expect(response.session_id.length).toBeGreaterThan(0);
  });

  it("invokes node-pty.spawn with the requested command/args and translated env record", async () => {
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
    expect(args).toEqual(["/c", "echo hello"]);
    // node-pty accepts a Record<string, string>; tuples deduplicate
    // to the last value per envTuplesToRecord's contract.
    expect(options.env).toEqual({
      PATH: "/usr/bin",
      FOO: "bar",
    });
    // ADR-019 Tripwire 3 — useConptyDll MUST be `false`.
    expect(options.useConptyDll).toBe(false);
  });

  it("resize/write delegate to the underlying child and reject unknown session-ids", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.resize(session_id, 40, 120);
    expect(ctx.child.resize).toHaveBeenCalledWith(120, 40); // (cols, rows)

    const payload = new Uint8Array([0x68, 0x69]); // "hi"
    await ctx.host.write(session_id, payload);
    expect(ctx.child.write).toHaveBeenCalledWith(payload);

    // Unknown session-id rejections.
    await expect(ctx.host.resize("nope", 1, 1)).rejects.toThrow(/unknown sessionId/);
    await expect(ctx.host.write("nope", new Uint8Array())).rejects.toThrow(/unknown sessionId/);
  });

  it("close disposes subscriptions and is idempotent on unknown ids", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.close(session_id);
    // A second close on the same id is a no-op (the session was removed).
    await expect(ctx.host.close(session_id)).resolves.toBeUndefined();
    // close on a never-known id is also a no-op (not an error).
    await expect(ctx.host.close("nope")).resolves.toBeUndefined();
  });
});
