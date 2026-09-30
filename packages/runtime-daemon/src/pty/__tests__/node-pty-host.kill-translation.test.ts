// Windows kill translation at `NodePtyHost.kill`, asserted at the unit level:
//
//   * `SIGINT` calls `GenerateConsoleCtrlEvent(CTRL_C_EVENT=0, child.pid)`, never `taskkill` or
//     `process.kill`.
//   * `SIGTERM` calls `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT=1, child.pid)` and does not
//     escalate before the 2 s budget elapses.
//   * `SIGKILL` runs `taskkill /T /F /PID <pid>` directly, never `GenerateConsoleCtrlEvent`.
//   * `SIGHUP` behaves like `SIGTERM`.
//   * A `kill()` after the child has exited re-emits `onExit` from cache and calls no FFI.
//
// This runs on every platform because the Windows-only primitives are injected through
// `NodePtyHostDeps` (`generateConsoleCtrlEvent`, `spawnTaskkill`, `ptySpawn`, `platform`), so
// no real `kernel32.dll`, `taskkill.exe` or `node-pty` is loaded.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { NodePtyHost } from "../node-pty-host.js";
import type {
  ConsoleCtrlEvent,
  NodePtyChild,
  NodePtySpawnFn,
  TaskkillResult,
} from "../node-pty-host.js";
import { makeFakeChild } from "./_fakes.js";
import type { SpawnRequest } from "../pty-host-protocol.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

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
// Per-test host and recorded mocks
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

describe("NodePtyHost — Windows kill-translation", () => {
  it("SIGINT invokes GenerateConsoleCtrlEvent(CTRL_C_EVENT=0, child.pid) and does NOT call taskkill", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGINT");

    // SIGINT must translate to `CTRL_C_EVENT=0`, not `CTRL_BREAK_EVENT=1` or `process.kill`.
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockGCCE).toHaveBeenCalledWith(0, 12345);

    // SIGINT never touches the hard-stop path.
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // Windows never delegates to node-pty's own `kill()`, which does not reach the process
    // tree (`microsoft/node-pty#167`).
    expect(ctx.child.kill).not.toHaveBeenCalled();
  });

  it("SIGTERM invokes GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT=1, child.pid) and does not immediately escalate", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGTERM");

    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, 12345);

    // Graceful first: the 2 s escalation timer is still pending, so taskkill has not fired.
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    expect(ctx.child.kill).not.toHaveBeenCalled();
  });

  it("SIGKILL invokes taskkill directly and skips GenerateConsoleCtrlEvent", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGKILL");

    // SIGKILL is an immediate hard stop with no CTRL_BREAK_EVENT first.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(12345);

    expect(ctx.mockGCCE).not.toHaveBeenCalled();
    expect(ctx.child.kill).not.toHaveBeenCalled();
  });

  it("SIGHUP invokes GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT=1, child.pid) per documented SIGTERM-equivalent mapping", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGHUP");

    // SIGHUP is documented as SIGTERM-equivalent; a change to that mapping should fail here.
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, 12345);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Idempotency — kill after the child has already exited
// ----------------------------------------------------------------------------

describe("NodePtyHost — idempotency of kill after child exit (step-8 kill bullet)", () => {
  it("kill() on an already-exited session re-emits onExit from cache and does NOT call any FFI", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
      vi.fn();
    ctx.host.setOnExit(exitRecorder);

    // The child exits on its own; the `onExit` subscription from `spawn()` caches the code.
    ctx.triggerExit(0);

    expect(exitRecorder).toHaveBeenCalledTimes(1);
    expect(exitRecorder).toHaveBeenCalledWith(session_id, 0);

    await ctx.host.kill(session_id, "SIGTERM");

    // Two fires: the child's own exit, then the re-emit from cache.
    expect(exitRecorder).toHaveBeenCalledTimes(2);
    expect(exitRecorder).toHaveBeenNthCalledWith(2, session_id, 0);

    // No FFI call, no taskkill, no node-pty kill.
    expect(ctx.mockGCCE).not.toHaveBeenCalled();
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    expect(ctx.child.kill).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Non-Windows pass-through
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
// Spawn, resize and write
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
    // node-pty takes a record; duplicate env tuples keep the last value.
    expect(options.env).toEqual({
      PATH: "/usr/bin",
      FOO: "bar",
    });
    // `useConptyDll` must stay `false`.
    expect(options.useConptyDll).toBe(false);
  });

  it("resize/write delegate to the underlying child and reject unknown session-ids", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.resize(session_id, 40, 120);
    expect(ctx.child.resize).toHaveBeenCalledWith(120, 40); // (cols, rows)

    const payload = new Uint8Array([0x68, 0x69]); // "hi"
    await ctx.host.write(session_id, payload);
    expect(ctx.child.write).toHaveBeenCalledWith(payload);

    await expect(ctx.host.resize("nope", 1, 1)).rejects.toThrow(/unknown sessionId/);
    await expect(ctx.host.write("nope", new Uint8Array())).rejects.toThrow(/unknown sessionId/);
  });

  it("close disposes subscriptions and is idempotent on unknown ids", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.close(session_id);
    // Closing twice, or closing an unknown id, is a no-op.
    await expect(ctx.host.close(session_id)).resolves.toBeUndefined();
    await expect(ctx.host.close("nope")).resolves.toBeUndefined();
  });
});
