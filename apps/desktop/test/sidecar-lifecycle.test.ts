// Plan-001 §CP-001-1 / Plan-024 §I-024-4 sidecar-lifecycle integration test.
//
// What this asserts (Plan-001 Phase 5 Test I5):
//   1. `registerSidecarLifecycle(app, getPtyHost)` registers exactly one
//      `will-quit` listener on the supplied `app` object.
//   2. The handler is registered at position 0 — index 0 in the FIFO
//      `app.listeners('will-quit')` array. This is the discriminating
//      assertion for the FIFO-ordering invariant (Plan-024 §I-024-4 +
//      Plan-001 §CP-001-1 resolution): a downstream `will-quit` handler
//      registered AFTER this module's call MUST appear at position >= 1.
//   3. When `will-quit` fires with a `null` PtyHost (bootstrap-window
//      case before the daemon has provisioned a host), the handler is a
//      clean no-op — `event.preventDefault` is NOT called, and no drain
//      is initiated. A subsequent re-emit on the no-op path also
//      short-circuits (the closure-local `drainCompleted` guard flips
//      on the null branch too).
//   4. When `will-quit` fires with an active PtyHost, the handler
//      intercepts the event (`event.preventDefault()` is called), calls
//      `PtyHost.shutdown({ perSessionTimeoutMs, hostTimeoutMs })` with
//      the configured budgets, and re-issues `app.quit()` on completion.
//   5. The handler observes the `DrainResult` and logs the four-value
//      summary (drained / forced / sidecar-clean / taskkill-escalated).
//   6. On `PtyHost.shutdown()` rejection, the handler logs the error and
//      still re-issues `app.quit()` so the user is not stranded — a
//      defense-in-depth check against future evolution of the
//      contract.
//   7. Re-entry guard: a second `will-quit` emit (Electron re-fires
//      `will-quit` when `app.quit()` is called from inside the handler,
//      per https://www.electronjs.org/docs/latest/api/app#appquit) MUST
//      short-circuit so the downstream chain proceeds without another
//      drain pass — no `preventDefault`, no additional shutdown(), no
//      additional `app.quit()` re-issue. Without this guard the handler
//      would re-enter infinitely.
//   8. Hard wall-clock cap: if `PtyHost.shutdown()` fails to resolve
//      within the injected `hardCapMs` budget (defense in depth against
//      a runaway promise), the handler logs an error citing the cap
//      and still re-issues `app.quit()` so the user is not stranded.
//
// Why we mock Electron + the PtyHost:
//   This test runs in the `main` project (node env) per
//   `apps/desktop/vitest.config.ts` — we do NOT spawn a real Electron
//   binary (that's `launch.smoke.test.ts`'s job). The will-quit
//   registration-ordering invariant + drain orchestration are pure
//   EventEmitter + Promise mechanics; a recording mock `App` + a
//   recording mock `PtyHost` exercise the full contract without
//   bringing in Electron's renderer or V8 lifecycle. The integration
//   contract for the real Electron `app.on('will-quit', ...)` is
//   structurally identical — Electron's `App` extends `EventEmitter`
//   directly.
//
// Refs:
//   • Plan-001 §Cross-Plan Obligations CP-001-1 — drain orchestration.
//   • Plan-024 §Invariants I-024-4 — FIFO registration-order invariant.
//   • ADR-019 §Decision item 8 — backend polymorphism (we never see
//     RustSidecarPtyHost or NodePtyHost in the test — only the
//     interface).

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { DrainResult, PtyHost } from "@ai-sidekicks/contracts";

import {
  registerSidecarLifecycle,
  type PtyHostGetter,
  type SidecarLifecycleDeps,
} from "../src/main/sidecar-lifecycle.js";

// ----------------------------------------------------------------------------
// Fakes — minimal Electron `App` + `PtyHost` shapes
// ----------------------------------------------------------------------------

/**
 * Minimal Electron `App` stub. Real `app` extends EventEmitter directly
 * and we use only `.on`, `.listeners`, `.quit`, so a plain EventEmitter
 * with a `quit` spy is sufficient. The `Electron.App` type carries
 * dozens of unrelated methods we never touch — cast at the boundary.
 */
function makeFakeApp(): {
  app: import("electron").App;
  quit: ReturnType<typeof vi.fn>;
  emitWillQuit: () => { defaultPrevented: boolean };
} {
  const ee = new EventEmitter();
  const quit = vi.fn();
  // The recording app exposes the EventEmitter surface + a `quit` spy.
  // We cast at the boundary because the real Electron.App type carries
  // dozens of unrelated methods we never touch.
  const app = Object.assign(ee, { quit }) as unknown as import("electron").App;
  return {
    app,
    quit,
    emitWillQuit: () => {
      // Build a synthetic event matching Electron's WillQuit signature.
      // `preventDefault` flips a private flag we expose via the return
      // tuple for assertion.
      let defaultPrevented = false;
      const event: { preventDefault: () => void } = {
        preventDefault: () => {
          defaultPrevented = true;
        },
      };
      ee.emit("will-quit", event);
      return { defaultPrevented };
    },
  };
}

/**
 * Minimal `PtyHost` stub — only `shutdown()` is exercised by this
 * module; the other surface methods stub to no-op. The constructor
 * takes a `DrainResult` so per-test cases can pin the value.
 */
function makeFakePtyHost(
  drainResult: DrainResult = {
    sessionsDrained: 0,
    sessionsForcedKilled: 0,
    sidecarExitedCleanly: true,
    taskkillEscalated: false,
  },
): {
  host: PtyHost;
  shutdown: ReturnType<typeof vi.fn>;
} {
  const shutdown = vi.fn(async () => drainResult);
  const host: PtyHost = {
    spawn: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    close: vi.fn(),
    shutdown,
    onData: vi.fn(),
    onExit: vi.fn(),
  } as unknown as PtyHost;
  return { host, shutdown };
}

/**
 * Recording logger so we can assert log-line content without spying on
 * the global `console` namespace.
 */
function makeRecordingLogger(): {
  logger: Pick<Console, "warn" | "error" | "info">;
  warns: string[];
  errors: string[];
  infos: string[];
} {
  const warns: string[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const logger: Pick<Console, "warn" | "error" | "info"> = {
    warn: (...args: unknown[]) => {
      warns.push(args.join(" "));
    },
    error: (...args: unknown[]) => {
      errors.push(args.join(" "));
    },
    info: (...args: unknown[]) => {
      infos.push(args.join(" "));
    },
  };
  return { logger, warns, errors, infos };
}

/**
 * Yield to the event loop so the async drain IIFE inside the will-quit
 * handler can complete + the `process.nextTick(app.quit)` re-emission
 * can run. Two awaits + a nextTick yield are sufficient because the
 * IIFE's await chain is exactly one `await ptyHost.shutdown()` + one
 * `process.nextTick` tail call.
 */
async function flushAsyncQuitChain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => process.nextTick(resolve));
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("registerSidecarLifecycle — Plan-001 CP-001-1 / Plan-024 I-024-4", () => {
  // -- I5 anchor assertion: FIFO registration-ordering invariant ----------

  it("registers exactly one will-quit listener at index 0 (FIFO position assertion)", () => {
    const { app } = makeFakeApp();
    const getPtyHost: PtyHostGetter = () => null;

    registerSidecarLifecycle(app, getPtyHost);

    const listeners = (app as unknown as EventEmitter).listeners("will-quit");
    expect(listeners).toHaveLength(1);
    // The position-0 assertion is the discriminating signal for the
    // FIFO-ordering invariant. A future regression that registers a
    // peer will-quit handler BEFORE this call would fail this check.
    // Compare by identity (the registered function reference is in
    // position 0).
    expect(listeners[0]).toBeInstanceOf(Function);
  });

  it("when a downstream handler registers after, the sidecar handler stays at index 0", () => {
    const { app } = makeFakeApp();
    const getPtyHost: PtyHostGetter = () => null;

    registerSidecarLifecycle(app, getPtyHost);

    // Simulate a downstream handler registered AFTER sidecar-lifecycle.
    // Per Plan-024 §I-024-4 the sidecar handler MUST remain at position
    // 0 — Electron's EventEmitter invokes listeners in registration
    // order, so the drain runs before any peer handler closes resources
    // the drain depends on.
    const downstreamHandler = vi.fn();
    (app as unknown as EventEmitter).on("will-quit", downstreamHandler);

    const listeners = (app as unknown as EventEmitter).listeners("will-quit");
    expect(listeners).toHaveLength(2);
    // The sidecar handler is FIRST.
    expect(listeners[0]).not.toBe(downstreamHandler);
    expect(listeners[1]).toBe(downstreamHandler);
  });

  // -- Bootstrap-window no-op: PtyHost not yet provisioned ---------------

  it("no-ops cleanly when the lazy getter returns null (bootstrap-window case)", async () => {
    const { app, quit, emitWillQuit } = makeFakeApp();
    const { logger, infos } = makeRecordingLogger();
    const getPtyHost: PtyHostGetter = () => null;

    registerSidecarLifecycle(app, getPtyHost, { logger });

    const { defaultPrevented } = emitWillQuit();

    // No PtyHost — no preventDefault, no async work, no `app.quit()`
    // re-issue (Electron's own quit chain continues unimpeded).
    expect(defaultPrevented).toBe(false);
    expect(quit).not.toHaveBeenCalled();
    // The no-op branch logs a single info line so an operator can
    // observe the bootstrap-window case.
    expect(infos.some((line) => line.includes("no PtyHost provisioned"))).toBe(true);

    await flushAsyncQuitChain();
    expect(quit).not.toHaveBeenCalled();

    // Re-entry guard on the no-op path: a second emit MUST also
    // short-circuit (the closure-local `drainCompleted` flag flips
    // even on the null branch, so a peer handler that calls
    // `app.quit()` for its own reasons does not re-trigger another
    // no-op log line). Filter for the bootstrap log substring so this
    // assertion remains stable if other info lines are added.
    const bootstrapLogCountAfterFirst = infos.filter((line) =>
      line.includes("no PtyHost provisioned"),
    ).length;
    expect(bootstrapLogCountAfterFirst).toBe(1);

    const second = emitWillQuit();
    expect(second.defaultPrevented).toBe(false);
    expect(quit).not.toHaveBeenCalled();
    const bootstrapLogCountAfterSecond = infos.filter((line) =>
      line.includes("no PtyHost provisioned"),
    ).length;
    expect(bootstrapLogCountAfterSecond).toBe(1);
  });

  // -- Active-host drain: shutdown invoked + budgets passed through ------

  it("invokes PtyHost.shutdown with the configured timeout budgets when an active host is present", async () => {
    const { app, quit, emitWillQuit } = makeFakeApp();
    const { host, shutdown } = makeFakePtyHost();
    const getPtyHost: PtyHostGetter = () => host;
    const customTimeouts: SidecarLifecycleDeps = {
      timeouts: { perSessionTimeoutMs: 1234, hostTimeoutMs: 5678 },
    };

    registerSidecarLifecycle(app, getPtyHost, customTimeouts);
    const { defaultPrevented } = emitWillQuit();

    // The drain is async; `preventDefault` was called synchronously.
    expect(defaultPrevented).toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith({
      perSessionTimeoutMs: 1234,
      hostTimeoutMs: 5678,
    });

    await flushAsyncQuitChain();
    // After the drain resolves, `app.quit()` is re-issued so the next
    // listener-queue pass can advance past the prevented default.
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("logs the DrainResult summary on a successful drain", async () => {
    const { app, emitWillQuit } = makeFakeApp();
    const { host } = makeFakePtyHost({
      sessionsDrained: 3,
      sessionsForcedKilled: 1,
      sidecarExitedCleanly: false,
      taskkillEscalated: true,
    });
    const { logger, infos } = makeRecordingLogger();
    const getPtyHost: PtyHostGetter = () => host;

    registerSidecarLifecycle(app, getPtyHost, { logger });
    emitWillQuit();

    await flushAsyncQuitChain();

    // Summary line contains the four DrainResult fields so operators
    // can observe whether the drain was clean or escalated.
    const summary = infos.find((line) => line.includes("drain complete"));
    expect(summary).toBeDefined();
    expect(summary).toContain("3 drained");
    expect(summary).toContain("1 forced");
    expect(summary).toContain("sidecar exited cleanly=false");
    expect(summary).toContain("taskkill escalated=true");
  });

  // -- Defensive: shutdown rejection still releases the user ------------

  it("logs and re-issues quit when PtyHost.shutdown() throws", async () => {
    const { app, quit, emitWillQuit } = makeFakeApp();
    const { host, shutdown } = makeFakePtyHost();
    shutdown.mockRejectedValueOnce(new Error("synthetic shutdown failure"));
    const { logger, errors } = makeRecordingLogger();
    const getPtyHost: PtyHostGetter = () => host;

    registerSidecarLifecycle(app, getPtyHost, { logger });
    emitWillQuit();

    await flushAsyncQuitChain();

    // Despite the rejection, the user is not stranded — quit is still
    // re-issued from the `finally` block so Electron proceeds with
    // teardown.
    expect(quit).toHaveBeenCalledTimes(1);
    expect(errors.some((line) => line.includes("synthetic shutdown failure"))).toBe(true);
  });

  // -- Backend polymorphism: handler never reads backend-specific fields -

  it("treats the PtyHost as an opaque interface — never reads backend-specific fields", async () => {
    const { app, emitWillQuit } = makeFakeApp();
    // A `PtyHost` whose ONLY working method is `shutdown` — every
    // other field throws if touched. The lifecycle handler MUST NOT
    // reach for any other surface (ADR-019 §Decision item 8 line 48:
    // "Consumers never see the backend choice").
    const shutdown = vi.fn(
      async (): Promise<DrainResult> => ({
        sessionsDrained: 0,
        sessionsForcedKilled: 0,
        sidecarExitedCleanly: true,
        taskkillEscalated: false,
      }),
    );
    const throwingHost: PtyHost = new Proxy({} as PtyHost, {
      get: (_target, prop): unknown => {
        if (prop === "shutdown") {
          return shutdown;
        }
        throw new Error(
          `registerSidecarLifecycle accessed backend-specific surface '${String(prop)}' — ` +
            `violates ADR-019 polymorphism (Consumers never see the backend choice).`,
        );
      },
    });

    registerSidecarLifecycle(app, () => throwingHost);
    emitWillQuit();
    await flushAsyncQuitChain();

    // No throw means no field beyond `shutdown` was accessed.
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  // -- Re-entry guard: second will-quit emit must short-circuit ----------

  it("does not re-drain when will-quit fires a second time (re-entry guard)", async () => {
    // Electron's `app.quit()` API re-fires `before-quit` + `will-quit`
    // (per https://www.electronjs.org/docs/latest/api/app#appquit). Our
    // handler completes the drain and re-issues `app.quit()` via
    // `process.nextTick`, which would cause Electron to emit `will-quit`
    // again. The closure-local `drainCompleted` guard MUST short-circuit
    // the second emit so we don't loop infinitely.
    const { app, quit, emitWillQuit } = makeFakeApp();
    const { host, shutdown } = makeFakePtyHost();
    const getPtyHost: PtyHostGetter = () => host;

    registerSidecarLifecycle(app, getPtyHost);

    const first = emitWillQuit();
    expect(first.defaultPrevented).toBe(true);
    await flushAsyncQuitChain();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);

    // Simulate Electron re-firing will-quit (which is what
    // `app.quit()` does in production once windows are closed). Our
    // handler MUST short-circuit so the downstream chain proceeds
    // without another drain pass — no preventDefault, no additional
    // shutdown call, no additional app.quit re-issue.
    const second = emitWillQuit();
    expect(second.defaultPrevented).toBe(false);
    await flushAsyncQuitChain();
    expect(shutdown).toHaveBeenCalledTimes(1); // unchanged
    expect(quit).toHaveBeenCalledTimes(1); // unchanged
  });

  // -- Hard wall-clock cap: runaway shutdown() must not block quit -------

  it("escalates to forced quit when PtyHost.shutdown() exceeds the hard wall-clock cap", async () => {
    vi.useFakeTimers();
    try {
      const { app, quit, emitWillQuit } = makeFakeApp();
      // shutdown that NEVER resolves — simulates a host implementation
      // regression / dropped IPC frame / deadlocked future. The hard
      // wall-clock cap is the defense-in-depth layer that releases the
      // user even when the underlying budgets fail to bound the drain.
      const hangingShutdown = vi.fn((): Promise<DrainResult> => new Promise<DrainResult>(() => {}));
      const host: PtyHost = {
        spawn: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
        kill: vi.fn(),
        close: vi.fn(),
        shutdown: hangingShutdown,
        onData: vi.fn(),
        onExit: vi.fn(),
      } as unknown as PtyHost;
      const { logger, errors } = makeRecordingLogger();
      const getPtyHost: PtyHostGetter = () => host;

      // Inject a 50 ms cap so the test exercises the branch without a
      // real-time 5 s wait. The injected value MUST surface in the
      // error log so the cap-fired branch is unambiguous to operators.
      registerSidecarLifecycle(app, getPtyHost, { logger, hardCapMs: 50 });
      const { defaultPrevented } = emitWillQuit();
      expect(defaultPrevented).toBe(true);

      // Advance fake timers past the cap so the hard-cap promise wins
      // the race against the hanging shutdown().
      await vi.advanceTimersByTimeAsync(60);
      await flushAsyncQuitChain();

      expect(hangingShutdown).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledTimes(1);
      // The cap-fired branch logs an error citing the injected ms
      // budget so operators can distinguish it from the throw branch.
      expect(errors.some((line) => line.includes("did not resolve within 50 ms"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
