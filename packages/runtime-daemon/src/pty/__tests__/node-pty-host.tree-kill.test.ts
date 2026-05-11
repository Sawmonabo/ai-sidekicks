// Test K3 — Windows hard-stop tree-kill via `taskkill /T /F`, with a
// 2 s bounded escalation timer (per I-024-2).
//
// Plan-024 I-024-2 promotes the following obligation to load-bearing:
//
//   * Hard-stop teardown MUST invoke `taskkill /T /F /PID <pid>` so the
//     entire descendant tree terminates (a single-PID kill leaves
//     descendants orphaned on Windows per microsoft/node-pty#437).
//   * The escalation MUST be bounded — invoke `taskkill` with a timeout,
//     and emit `ExitCodeNotification` (the daemon-layer analog: fire
//     `onExit`) even if the OS-level reap is incomplete. The daemon
//     MUST NOT hang on a stuck `taskkill` invocation.
//   * Reaping MUST be idempotent.
//
// This test exercises the escalation path: a `SIGTERM` whose child
// ignores `CTRL_BREAK_EVENT` MUST cascade to `taskkill /T /F /PID <pid>`
// after the 2 s budget, and `onExit` MUST fire regardless of
// `taskkill`'s actual reap outcome.
//
// Tree-kill semantics are validated by asserting that the `taskkill`
// invocation receives the root PID (the OS walks the tree via `/T`
// once that PID is targeted). The descendant tree is not modeled in
// this unit test — that's the Phase 3 sidecar-side Test K4 which has
// access to a real `windows-latest` runner per Plan-024 §I-024-2.
//
// Refs: Plan-024 §Invariants I-024-2; ADR-019 §Decision item 1;
// ADR-019 §Failure Mode Analysis row "kill propagation".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { NodePtyHost } from "../node-pty-host.js";
import type {
  ConsoleCtrlEvent,
  NodePtyChild,
  NodePtySpawnFn,
  TaskkillResult,
} from "../node-pty-host.js";
import { makeFakeChild } from "./_fakes.js";

import type { SpawnRequest } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Test fixtures — shared `makeFakeChild` helper imported from `_fakes.ts`
// ----------------------------------------------------------------------------
//
// Default pid for this suite is 67890 (distinct from the kill-
// translation suite's 12345 so assertion failures point unambiguously
// at the failing fixture). See `_fakes.ts` for the helper definition
// shared with `node-pty-host.kill-translation.test.ts` (R3 review
// POLISH-2 / POLISH-3).
const TREE_KILL_FIXTURE_PID = 67890;

const SAMPLE_SPAWN: SpawnRequest = {
  kind: "spawn_request",
  command: "cmd.exe",
  args: ["/c", "ping -t 127.0.0.1"], // a long-running command, in spirit
  env: [],
  cwd: "C:\\daemon-stable-parent",
  rows: 24,
  cols: 80,
};

interface TreeKillCtx {
  host: NodePtyHost;
  child: NodePtyChild;
  triggerExit: (exitCode: number, signal?: number) => void;
  mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void>;
  mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>>;
  ptySpawnStub: Mock<NodePtySpawnFn>;
  exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void>;
}

let ctx: TreeKillCtx;

beforeEach(() => {
  // Fake timers: vi.advanceTimersByTime(2000) deterministically fires
  // the 2 s escalation timer without waiting wall-clock seconds.
  vi.useFakeTimers();

  const { child, triggerExit } = makeFakeChild(TREE_KILL_FIXTURE_PID);
  // GCCE that does NOTHING — the test scenario is "child ignores
  // CTRL_BREAK_EVENT", so the GCCE call returns without triggering an
  // exit. The escalation timer fires the taskkill cascade.
  const mockGCCE: Mock<(event: ConsoleCtrlEvent, pid: number) => void> = vi.fn();
  const mockTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
    .fn<(pid: number) => Promise<TaskkillResult>>()
    .mockResolvedValue({ exitCode: 0 });
  const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
  const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
    vi.fn();

  const host = new NodePtyHost({
    platform: "win32",
    ptySpawn: ptySpawnStub,
    generateConsoleCtrlEvent: mockGCCE,
    spawnTaskkill: mockTaskkill,
  });
  host.setOnExit(exitRecorder);

  ctx = {
    host,
    child,
    triggerExit,
    mockGCCE,
    mockTaskkill,
    ptySpawnStub,
    exitRecorder,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

// ----------------------------------------------------------------------------
// I-024-2: 2 s escalation + tree-kill + onExit emission
// ----------------------------------------------------------------------------

describe("NodePtyHost — hard-stop escalation to taskkill /T /F (I-024-2)", () => {
  it("SIGTERM whose child ignores CTRL_BREAK_EVENT escalates to taskkill at the 2 s budget and emits onExit regardless of OS reap status", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // Kick the graceful kill. The implementation arms a 2 s timer and
    // returns synchronously (we await it because the API is async, but
    // it does NOT block on the timer).
    await ctx.host.kill(session_id, "SIGTERM");

    // T+0: graceful CTRL_BREAK_EVENT fired (the test's GCCE is a
    // no-op; we just verify the call shape).
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, 67890);

    // Pre-budget: taskkill MUST NOT have fired yet.
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // Advance time by less than the budget — still no escalation.
    await vi.advanceTimersByTimeAsync(1999);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // Cross the 2 s budget — the timer fires synchronously, which
    // kicks off the async invokeTaskkill(). `advanceTimersByTimeAsync`
    // also drains the resulting microtasks so the mockTaskkill promise
    // resolves and the post-resolution onExit fire is observable.
    await vi.advanceTimersByTimeAsync(1);

    // Load-bearing assertion: I-024-2 — `taskkill` MUST receive the
    // root PID with the /T flag implied (the production code spawns
    // ['taskkill', '/T', '/F', '/PID', String(pid)]; the injected
    // mock receives the pid arg directly so we assert the pid value).
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(67890);

    // Load-bearing assertion: I-024-2 — onExit MUST fire even when
    // the OS-level reap is opaque (the mockTaskkill resolves
    // successfully here; the implementation emits anyway, and an
    // unsuccessful taskkill should also emit per the I-024-2
    // "MUST emit ExitCodeNotification even if reaping is incomplete"
    // clause — covered by the next test).
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    const [emittedSessionId, emittedExitCode] = ctx.exitRecorder.mock.calls[0]!;
    expect(emittedSessionId).toBe(session_id);
    expect(emittedExitCode).toBe(1);
  });

  // NOTE: A standalone "the 2 s budget is timer-bounded" sanity check
  // was removed in R3 review POLISH-1. The assertion (`Date.now() -
  // start < 1000`) passed trivially under `vi.useFakeTimers()` because
  // Vitest fakes `Date.now()` by default, so the wall-clock comparison
  // had no teeth. The non-blocking property is already proven by the
  // tests above and below: they only progress when
  // `advanceTimersByTimeAsync` simulates time, which would deadlock if
  // production code awaited real wall-clock seconds inside `kill()`.

  it("if the child exits BEFORE the 2 s budget elapses, the escalation is cancelled and taskkill is never called", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.kill(session_id, "SIGTERM");

    // Simulate the child responding to CTRL_BREAK_EVENT at T+1s (well
    // inside the 2 s budget). The node-pty `onExit` subscription that
    // was attached during `spawn()` clears the pending escalation
    // timer.
    await vi.advanceTimersByTimeAsync(1000);
    ctx.triggerExit(0);

    // Now exhaust the original 2 s budget — taskkill MUST NOT fire
    // because the timer was cleared on the early exit.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // Only one onExit emission — from the child's own exit, not from
    // an escalation path.
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(session_id, 0);
  });

  it("emits onExit even when taskkill itself fails (OS-level reap stalled)", async () => {
    // I-024-2: "invoke taskkill with a timeout and emit
    // ExitCodeNotification even if reaping is incomplete." We exercise
    // the failure mode by making the mock reject.
    ctx.mockTaskkill.mockRejectedValueOnce(new Error("taskkill: access denied"));

    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.kill(session_id, "SIGTERM");
    await vi.advanceTimersByTimeAsync(2000);

    // taskkill was attempted (the load-bearing piece of I-024-2 is
    // that we INVOKED the escalation; whether it succeeded is OS-
    // dependent and we must still fire onExit).
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(67890);

    // onExit MUST still fire — daemon-side projector marks the
    // session terminated regardless of OS-level reap outcome.
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(session_id, 1);
  });

  it("SIGKILL bypasses the 2 s budget and invokes taskkill immediately", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);
    await ctx.host.kill(session_id, "SIGKILL");

    // Per Plan-024 §Step 8 line 120: SIGKILL is "taskkill /T /F /PID
    // <pid> directly, skipping CTRL_BREAK_EVENT". The mock is async
    // (`mockResolvedValue`); we have already awaited `host.kill` so
    // by the time we assert the resolution chain has run.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(67890);

    // No GCCE call — SIGKILL skips graceful.
    expect(ctx.mockGCCE).not.toHaveBeenCalled();

    // onExit fires immediately (no 2 s budget).
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledWith(session_id, 1);
  });
});

// ----------------------------------------------------------------------------
// R2 review ACTIONABLE-1 — synthetic-exit cache is write-once
// ----------------------------------------------------------------------------
//
// When `invokeTaskkill` emits a synthetic onExit (exitCode=1), a later
// real OS exit arriving via the `child.onExit` subscription MUST NOT
// re-fire onExit AND MUST NOT mutate the cache. The cache is
// write-once after first emission so the idempotency contract on
// `kill()` holds: a subsequent kill on an already-exited session
// re-emits the SAME exitCode the consumer originally observed (the
// synthetic 1), not the later OS-reported value (often 0 for clean
// exits).
//
// This test simultaneously covers the dedup branch inside
// `child.onExit` (POLISH-4 from R2 review — implicit subsumption).

describe("NodePtyHost — synthetic-exit cache is write-once (R2 ACTIONABLE-1)", () => {
  it("post-synthetic-exit OS exit does not re-fire and does not mutate the cache; subsequent kill() re-emits the synthetic exitCode", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: graceful SIGTERM kicks the 2 s escalation timer.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, 67890);

    // T+2s: timer fires → invokeTaskkill → mockTaskkill resolves →
    // synthetic onExit(exitCode=1) emitted.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);
    expect(ctx.exitRecorder).toHaveBeenNthCalledWith(1, session_id, 1);

    // T+2s+ε: the real OS exit arrives — e.g., taskkill succeeded at
    // the OS layer and the child.onExit subscription fires with the
    // real exit code (0 for a clean reap). This MUST NOT re-fire
    // onExit and MUST NOT mutate the cached `exitCode`.
    ctx.triggerExit(0);

    // Load-bearing: only ONE onExit observed across the whole flow.
    // The real OS exit was de-duped at the cache-guard inside
    // `child.onExit`. (Pre-R2-ACTIONABLE-1 fix: the cache was mutated
    // to 0 here, breaking the next assertion.)
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(1);

    // Idempotency clause: a subsequent kill() re-emits from the cache
    // — and the cached exitCode MUST still be the synthetic 1, NOT 0.
    // This is the load-bearing property: consumers that observed
    // `exitCode=1` on the first emission must keep seeing `exitCode=1`
    // on any later idempotent re-emit, or the daemon's session
    // projector sees an inconsistent exit history.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.exitRecorder).toHaveBeenCalledTimes(2);
    expect(ctx.exitRecorder).toHaveBeenNthCalledWith(2, session_id, 1);

    // Negative — the idempotent re-emit MUST NOT call FFI / taskkill.
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1); // only the original SIGTERM
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1); // only the original escalation
  });
});

// ----------------------------------------------------------------------------
// R2 review ACTIONABLE-3 — stale SIGTERM-armed timer must be cleared
// when a later kill preempts it
// ----------------------------------------------------------------------------
//
// Without the `clearPendingEscalation` call at the top of every
// killOnWindows branch, an in-flight SIGTERM-armed timer would still
// fire 2 s after its arming even when a subsequent SIGKILL has
// already killed the child. The orphaned timer would re-invoke
// `taskkill /T /F /PID <pid>` on a potentially-reaped-and-recycled
// Windows PID — the canonical "spam-click Stop then Force Stop"
// real-world trigger.

describe("NodePtyHost — preemption clears stale escalation timer (R2 ACTIONABLE-3)", () => {
  it("SIGKILL after SIGTERM clears the pending 2 s escalation timer; mockTaskkill fires exactly once", async () => {
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: SIGTERM arms the 2 s timer.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // T+1s: still inside the budget — timer hasn't fired yet.
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // T+1s: SIGKILL preempts. Without the R2 ACTIONABLE-3 fix the
    // SIGTERM-armed timer remains pending and would fire at T+2s,
    // invoking `mockTaskkill` a SECOND time. With the fix, the
    // SIGKILL branch calls `clearPendingEscalation` first, so the
    // timer is cancelled. mockTaskkill fires exactly once (from
    // SIGKILL).
    await ctx.host.kill(session_id, "SIGKILL");
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);

    // Drain past the original SIGTERM's 2 s escalation point.
    await vi.advanceTimersByTimeAsync(1500);

    // Load-bearing: mockTaskkill MUST be called EXACTLY ONCE across
    // the whole flow (the SIGKILL invocation only). A second
    // invocation from the orphaned SIGTERM timer would be a
    // regression of the R2 ACTIONABLE-3 fix.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(67890);
  });

  it("two consecutive SIGTERMs arm only one live timer; mockTaskkill fires once at T+2s of the SECOND arming", async () => {
    // Bug scenario B from R2 ACTIONABLE-3: repeated SIGTERMs both
    // arm timers; the second overwrites `record.pendingEscalation`
    // without clearing the first, leaving an orphaned timer.
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: first SIGTERM arms timer A (fires at T+2s).
    await ctx.host.kill(session_id, "SIGTERM");

    // T+1s: second SIGTERM. With the R2 fix the first timer is
    // cleared at the top of the branch; a fresh timer B arms (fires
    // at T+3s). Without the fix: timer A still pending → fires at
    // T+2s; timer B → fires at T+3s → mockTaskkill fires twice.
    await vi.advanceTimersByTimeAsync(1000);
    await ctx.host.kill(session_id, "SIGTERM");

    // T+2s: under the fix, the cleared timer A does NOT fire. Only
    // timer B (T+3s) is live. mockTaskkill stays at 0.
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // T+3s: timer B fires. mockTaskkill fires exactly once.
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);

    // Drain well past the orphan-would-have-fired point.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
  });

  it("SIGINT after SIGTERM clears the pending escalation timer; mockTaskkill never fires", async () => {
    // Bug scenario C from R2 ACTIONABLE-3.
    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    await ctx.host.kill(session_id, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);

    // SIGINT preempts. With the R2 fix the SIGTERM-armed timer is
    // cleared before the SIGINT-translation runs.
    await ctx.host.kill(session_id, "SIGINT");

    // Drain past the original SIGTERM's 2 s escalation point.
    await vi.advanceTimersByTimeAsync(2000);

    // mockTaskkill MUST NEVER fire — SIGINT doesn't escalate to
    // taskkill, and the stale SIGTERM timer was cleared.
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();
    // SIGINT translation: CTRL_C_EVENT after CTRL_BREAK_EVENT.
    expect(ctx.mockGCCE).toHaveBeenCalledTimes(2);
    expect(ctx.mockGCCE).toHaveBeenNthCalledWith(1, 1, 67890); // SIGTERM
    expect(ctx.mockGCCE).toHaveBeenNthCalledWith(2, 0, 67890); // SIGINT
  });
});

// ----------------------------------------------------------------------------
// R2 review POLISH-4 — wall-clock timeout race in invokeTaskkill
// ----------------------------------------------------------------------------
//
// I-024-2: "the daemon must not hang on a stuck OS-level operation".
// If `spawnTaskkill(pid)` never resolves (kernel deadlock, suspended
// state, OS bug), the host's `invokeTaskkill` MUST still proceed to
// fire the synthetic onExit on its own schedule. The fix wraps the
// `await spawnTaskkill(pid)` in a race against a 5 s fallback timer
// driven by `this.deps.setTimer` / `clearTimer` (same primitives the
// 2 s escalation uses). A test that injects a never-resolving mock
// proves the race is wired correctly — without it, `invokeTaskkill`
// awaits forever and `onExit` never fires.

describe("NodePtyHost — invokeTaskkill is wall-clock bounded (R2 POLISH-4)", () => {
  it("SIGKILL with a never-resolving spawnTaskkill still fires onExit after the 5 s fallback timeout", async () => {
    // Build a host with a `spawnTaskkill` mock returning a Promise
    // that NEVER resolves. Simulates the I-024-2-prohibited "stuck
    // OS-level operation" failure mode.
    const { child } = makeFakeChild(12321);
    const neverResolves: Promise<TaskkillResult> = new Promise<TaskkillResult>(() => {
      // intentionally empty — the promise never settles.
    });
    const stuckTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
      .fn<(pid: number) => Promise<TaskkillResult>>()
      .mockReturnValue(neverResolves);
    const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
    const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
      vi.fn();

    const host = new NodePtyHost({
      platform: "win32",
      ptySpawn: ptySpawnStub,
      // GCCE shouldn't be called on the SIGKILL path; provide a
      // no-op so the host doesn't try to load the production FFI.
      generateConsoleCtrlEvent: vi.fn(),
      spawnTaskkill: stuckTaskkill,
    });
    host.setOnExit(exitRecorder);

    const { session_id } = await host.spawn(SAMPLE_SPAWN);

    // SIGKILL → invokeTaskkill awaits the (never-resolving)
    // spawnTaskkill in a race against a 5 s fallback timer. We
    // don't `await` host.kill here — the kill won't return until
    // the race settles, and we need to advance the fake timer first.
    const killPromise = host.kill(session_id, "SIGKILL");

    // Pre-5s: the spawnTaskkill mock was called immediately, but
    // the race has NOT settled — onExit has NOT fired yet.
    expect(stuckTaskkill).toHaveBeenCalledTimes(1);
    expect(stuckTaskkill).toHaveBeenCalledWith(12321);
    expect(exitRecorder).not.toHaveBeenCalled();

    // Advance just under the fallback budget — still pending.
    await vi.advanceTimersByTimeAsync(4999);
    expect(exitRecorder).not.toHaveBeenCalled();

    // Cross the 5 s boundary — fallback timer fires, race settles,
    // synthetic onExit emits.
    await vi.advanceTimersByTimeAsync(1);
    await killPromise;

    // Load-bearing: onExit MUST fire with the synthetic exitCode=1
    // even though the OS-level reap never completed. This is the
    // exact property I-024-2 requires.
    expect(exitRecorder).toHaveBeenCalledTimes(1);
    expect(exitRecorder).toHaveBeenCalledWith(session_id, 1);
  });
});

// ----------------------------------------------------------------------------
// R3 review ACTIONABLE-1 — synthetic-exit must not fire on a closed session
// ----------------------------------------------------------------------------
//
// `invokeTaskkill` awaits `spawnTaskkill` (or the 5 s fallback) inside
// an async IIFE that captures `record` + `sessionId` by closure. If
// `close()` lands during that await (the consumer canceled the
// session mid-escalation), `this.sessions.delete(sessionId)` removes
// the table entry — but the closure still holds the references, so
// the post-await synthetic-emit block would call `fireExit` on a
// torn-down session unless the production code explicitly re-checks
// `this.sessions.has(sessionId)` before firing.
//
// The fix gates the synthetic emission on the membership probe. These
// three tests cover each race shape so a future reader sees the
// regression contract at a glance:
//
//   * SIGTERM → 2 s timer → taskkill in-flight → close → resolve
//   * SIGKILL → taskkill in-flight → close → resolve
//   * 5 s wall-clock fallback → close mid-flight → fallback fires
//
// One gate (`this.sessions.has(sessionId)`) covers all three; we still
// assert each shape independently because a regression that breaks
// the gate for one entry path could pass the others (e.g., a future
// refactor adds a separate fast-path for SIGKILL that forgets to
// route through the same gate).

describe("NodePtyHost — synthetic onExit gated on live session (R3 ACTIONABLE-1)", () => {
  it("SIGTERM: close() during 2 s escalation IIFE suppresses the synthetic onExit when spawnTaskkill resolves post-close", async () => {
    // Externally controllable taskkill resolution so we can interleave
    // close() between "await spawnTaskkill begins" and "spawnTaskkill
    // resolves". A `vi.fn().mockReturnValueOnce(deferred)` would also
    // work; the explicit `new Promise` + captured `resolve` is more
    // readable for the race scenario.
    let resolveTaskkill!: (value: TaskkillResult) => void;
    const taskkillPromise: Promise<TaskkillResult> = new Promise<TaskkillResult>((res) => {
      resolveTaskkill = res;
    });
    ctx.mockTaskkill.mockReturnValueOnce(taskkillPromise);

    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // T+0: SIGTERM arms the 2 s escalation timer.
    await ctx.host.kill(session_id, "SIGTERM");
    expect(ctx.mockGCCE).toHaveBeenCalledWith(1, TREE_KILL_FIXTURE_PID);
    expect(ctx.mockTaskkill).not.toHaveBeenCalled();

    // T+2s: timer fires synchronously; the IIFE inside invokeTaskkill
    // starts awaiting spawnTaskkill (which we've held open via the
    // captured resolver). The fake-timer advance drains all queued
    // microtasks, but spawnTaskkill stays unresolved.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(TREE_KILL_FIXTURE_PID);
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // T+2s+ε: consumer cancels the session mid-flight. After close,
    // `this.sessions.has(sessionId)` is false; the captured `record`
    // + `sessionId` inside the IIFE remain valid (closure-held).
    await ctx.host.close(session_id);

    // Now release the taskkill. The IIFE's finish() resolves the outer
    // Promise inside invokeTaskkill; control returns to the synthetic-
    // emit block. WITHOUT the R3 fix: fireExit runs, exitRecorder is
    // called with (sessionId, 1). WITH the fix: sessions.has gate
    // suppresses the emit.
    resolveTaskkill({ exitCode: 0 });

    // Drain pending microtasks so the post-await synthetic block runs.
    await vi.runAllTimersAsync();

    // Load-bearing: NO onExit fire on the torn-down session.
    expect(ctx.exitRecorder).not.toHaveBeenCalled();
  });

  it("SIGKILL: close() during the direct invokeTaskkill IIFE suppresses the synthetic onExit when spawnTaskkill resolves post-close", async () => {
    // SIGKILL skips the 2 s graceful step — invokeTaskkill is called
    // directly. The race is identical: an in-flight `await
    // spawnTaskkill(pid)` followed by a close() before the promise
    // settles must not fire the synthetic onExit.
    let resolveTaskkill!: (value: TaskkillResult) => void;
    const taskkillPromise: Promise<TaskkillResult> = new Promise<TaskkillResult>((res) => {
      resolveTaskkill = res;
    });
    ctx.mockTaskkill.mockReturnValueOnce(taskkillPromise);

    const { session_id } = await ctx.host.spawn(SAMPLE_SPAWN);

    // Kick SIGKILL without awaiting — invokeTaskkill is now in flight
    // inside the host, awaiting our held-open spawnTaskkill.
    const killPromise: Promise<void> = ctx.host.kill(session_id, "SIGKILL");

    // spawnTaskkill was invoked immediately; nothing else has happened.
    expect(ctx.mockTaskkill).toHaveBeenCalledTimes(1);
    expect(ctx.mockTaskkill).toHaveBeenCalledWith(TREE_KILL_FIXTURE_PID);
    expect(ctx.exitRecorder).not.toHaveBeenCalled();

    // Consumer cancels mid-flight.
    await ctx.host.close(session_id);

    // Resolve spawnTaskkill — drains the IIFE; without the gate, the
    // synthetic emit would fire on the torn-down session.
    resolveTaskkill({ exitCode: 0 });
    await vi.runAllTimersAsync();
    await killPromise;

    // Load-bearing: NO onExit fire on the torn-down session.
    expect(ctx.exitRecorder).not.toHaveBeenCalled();
  });

  it("5 s fallback race: close() during a never-resolving spawnTaskkill suppresses the synthetic onExit when the fallback timer wins", async () => {
    // Construct a dedicated host with a never-resolving spawnTaskkill,
    // mirroring the POLISH-4 wall-clock test above. Close()s during
    // the wall-clock wait; the 5 s fallback fires, the race settles
    // via the timeout path, and the gate must still suppress the
    // synthetic emit because the session was torn down.
    const { child } = makeFakeChild(45678);
    const neverResolves: Promise<TaskkillResult> = new Promise<TaskkillResult>(() => {
      // intentionally empty — the promise never settles.
    });
    const stuckTaskkill: Mock<(pid: number) => Promise<TaskkillResult>> = vi
      .fn<(pid: number) => Promise<TaskkillResult>>()
      .mockReturnValue(neverResolves);
    const ptySpawnStub: Mock<NodePtySpawnFn> = vi.fn<NodePtySpawnFn>().mockReturnValue(child);
    const exitRecorder: Mock<(sessionId: string, exitCode: number, signalCode?: number) => void> =
      vi.fn();

    const host = new NodePtyHost({
      platform: "win32",
      ptySpawn: ptySpawnStub,
      generateConsoleCtrlEvent: vi.fn(),
      spawnTaskkill: stuckTaskkill,
    });
    host.setOnExit(exitRecorder);

    const { session_id } = await host.spawn(SAMPLE_SPAWN);

    // SIGKILL → invokeTaskkill awaits never-resolving spawnTaskkill
    // in a race with the 5 s fallback timer.
    const killPromise: Promise<void> = host.kill(session_id, "SIGKILL");
    expect(stuckTaskkill).toHaveBeenCalledTimes(1);

    // Advance partway through the 5 s budget.
    await vi.advanceTimersByTimeAsync(2500);

    // Consumer cancels at T+2.5s, well before the fallback fires.
    await host.close(session_id);

    // Cross the 5 s boundary — fallback wins the race, finish()
    // resolves the outer Promise, control returns to the synthetic-
    // emit block. WITHOUT the R3 fix: fireExit runs even though the
    // session is gone. WITH the fix: gate suppresses the emit.
    await vi.advanceTimersByTimeAsync(2500);
    await killPromise;

    // Load-bearing: NO onExit fire on the torn-down session.
    expect(exitRecorder).not.toHaveBeenCalled();
  });
});
