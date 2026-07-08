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
//      is initiated. The closure-local `drainCompleted` flag is
//      DELIBERATELY NOT flipped on the null branch so a subsequent
//      `will-quit` emit (e.g., after a peer listener `preventDefault`s
//      the first quit and the daemon's PtyHost gets provisioned in the
//      interim) re-checks the getter and runs the drain when a host is
//      present. Permanently disabling the handler on a single null
//      emit would let live PTY sessions bypass the drain and outlive
//      app teardown.
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

    // No permanent disable on the null branch: a second emit with a
    // still-null getter MUST also no-op cleanly AND re-log the
    // bootstrap line. The closure-local `drainCompleted` flag is
    // deliberately NOT flipped on the null branch — that branch
    // issues no quit and runs no drain, so there is no re-entry to
    // guard against, and flipping it would permanently disable the
    // handler even when a later quit attempt finds a provisioned
    // PtyHost. Filter for the bootstrap log substring so this
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
    expect(bootstrapLogCountAfterSecond).toBe(2);
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
    // reach for any other surface (`ADR-019 §Decision` item 4:
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

  it("re-checks PtyHost on subsequent will-quit emits after a null-host bootstrap-window quit (no permanent disable)", async () => {
    // Bug pin: a null-host emit MUST NOT permanently disable the
    // handler. Failure trace:
    //   1. App boots; daemon's PtyHost not yet provisioned.
    //   2. User triggers quit; Electron emits `will-quit`. Our
    //      handler hits the null-host branch and no-ops cleanly.
    //   3. A peer `will-quit` listener (e.g., unsaved-work prompt)
    //      calls `event.preventDefault()`. Electron aborts the quit.
    //   4. App stays alive. Daemon finishes provisioning the
    //      PtyHost. User starts sessions. PTY children spawn.
    //   5. User triggers quit again. Electron re-emits `will-quit`.
    //      This handler MUST re-check the getter, find the now-
    //      provisioned PtyHost, and run the drain. If the null
    //      branch had flipped `drainCompleted = true` on emit (2),
    //      the top guard at emit (5) would short-circuit and PTY
    //      children would outlive teardown.
    //
    // Stateful getter: returns null on the first call (bootstrap
    // window) and the mock host on every subsequent call (daemon
    // has provisioned the host before the next quit attempt).
    const { app, quit, emitWillQuit } = makeFakeApp();
    const { host, shutdown } = makeFakePtyHost();
    let getterCalls = 0;
    const getPtyHost: PtyHostGetter = () => {
      getterCalls += 1;
      return getterCalls === 1 ? null : host;
    };

    registerSidecarLifecycle(app, getPtyHost);

    // First emit: bootstrap window — null host, clean no-op, no
    // `preventDefault`, no `shutdown` call, no `app.quit()` re-issue.
    const first = emitWillQuit();
    expect(first.defaultPrevented).toBe(false);
    await flushAsyncQuitChain();
    expect(shutdown).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(getterCalls).toBe(1);

    // Second emit: daemon's PtyHost is now provisioned. The handler
    // MUST re-enter, re-check the getter, find the host, call
    // `event.preventDefault()`, and invoke the drain. This is the
    // failure that the Codex finding pins: if `drainCompleted` had
    // been flipped on the null branch, the top guard would
    // short-circuit here and `shutdown` would never be called.
    const second = emitWillQuit();
    expect(second.defaultPrevented).toBe(true);
    await flushAsyncQuitChain();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });
    expect(quit).toHaveBeenCalledTimes(1);
    // Both emits re-checked the getter — proves the second emit did
    // NOT short-circuit at the top guard. (getterCalls === 1 after
    // emit 1 + getterCalls === 2 after emit 2.)
    expect(getterCalls).toBe(2);
  });

  it("re-enters drain path on subsequent will-quit emits after a peer listener cancels the re-issued quit (drainCompleted is a one-shot, not a permanent latch)", async () => {
    // Bug pin (Codex P1 on PR #83 commit 10043ea): the closure-local
    // `drainCompleted` flag was a permanent latch — set to `true` in
    // the async-drain `finally` and never cleared. If any peer
    // `will-quit` listener `event.preventDefault()`s the re-issued
    // `app.quit()` (e.g., unsaved-work prompt, mid-frame asset flush),
    // the app keeps running but our handler is permanently disabled:
    // the re-entry check at the top of the listener short-circuits
    // forever, so any future quit attempt skips the drain path
    // entirely and live PTY sessions outlive teardown.
    //
    // Fix: clear `drainCompleted = false` on the re-entry branch
    // (consumed-on-this-emit). Re-entry is safe because
    // `PtyHost.shutdown()` is memoized on both `NodePtyHost`
    // (`shutdownPromise` field) and `RustSidecarPtyHost` (equivalent
    // memoization) — a second `shutdown()` call returns the cached
    // `DrainResult` instantly.
    //
    // Failure trace this test discriminates:
    //   1. Emit 1: user triggers quit. Our handler calls
    //      `event.preventDefault()`, awaits the drain, flips
    //      `drainCompleted = true`, and re-issues `app.quit()` from
    //      `finally`.
    //   2. Emit 2 (re-issued by the mock's `app.quit` synchronously
    //      mirroring Electron's `will-quit` re-fire): our handler
    //      observes `drainCompleted === true`, clears it, returns
    //      without `preventDefault`. A peer listener
    //      `event.preventDefault()`s emit 2 — Electron aborts the
    //      quit chain.
    //   3. Emit 3: user retries quit later. Our handler observes
    //      `drainCompleted === false` (cleared on emit 2) and
    //      re-enters the drain path. Without the clear, our handler
    //      would short-circuit at the top guard and `shutdown` would
    //      never be called a second time — the discriminating
    //      assertion is `shutdownMock` call count after emit 3.
    //
    // One-off inline app fake: this test needs `app.quit()` to
    // synchronously re-emit `will-quit` (matching Electron's
    // behavior). Other tests in this file rely on `quit` being a
    // passive `vi.fn()` spy, so we build the fake inline rather than
    // mutating `makeFakeApp()`.
    const ee = new EventEmitter();
    let emitCount = 0;
    function emitWillQuit(): { defaultPrevented: boolean } {
      emitCount += 1;
      let defaultPrevented = false;
      const event: { preventDefault: () => void } = {
        preventDefault: () => {
          defaultPrevented = true;
        },
      };
      ee.emit("will-quit", event);
      return { defaultPrevented };
    }
    // `app.quit` synchronously emits `will-quit` — mirrors Electron's
    // re-fire behavior when `app.quit()` is called from inside a
    // will-quit handler (per
    // https://www.electronjs.org/docs/latest/api/app#appquit).
    const quit = vi.fn(() => {
      emitWillQuit();
    });
    const app = Object.assign(ee, { quit }) as unknown as import("electron").App;

    const { host, shutdown: shutdownMock } = makeFakePtyHost();
    const getPtyHost: PtyHostGetter = () => host;

    // Register the sidecar lifecycle FIRST (FIFO position 0).
    registerSidecarLifecycle(app, getPtyHost);

    // Peer `will-quit` listener registered AFTER (FIFO position 1).
    // It cancels ONLY the re-issued quit (the second emit) — a
    // realistic scenario: an unsaved-work confirmation dialog that
    // intervenes after the drain has already completed.
    let peerCalls = 0;
    const peerPreventedOn: number[] = [];
    ee.on("will-quit", (event) => {
      peerCalls += 1;
      if (peerCalls === 2) {
        event.preventDefault();
        peerPreventedOn.push(peerCalls);
      }
    });

    // --- Emit 1: user triggers quit ----------------------------------
    const first = emitWillQuit();
    expect(first.defaultPrevented).toBe(true); // our handler intercepted
    expect(emitCount).toBe(1);

    // Flush the async drain IIFE. The `finally` block flips
    // `drainCompleted = true`, schedules `process.nextTick(app.quit)`,
    // and on the nextTick the mock's `app.quit` synchronously emits
    // `will-quit` (= emit 2). During that synchronous emit 2 our
    // handler observes the flag, clears it, returns; the peer
    // listener then runs (call #2) and `preventDefault`s. By the time
    // this flush resolves, both emit 1 and emit 2 have happened.
    await flushAsyncQuitChain();

    expect(emitCount).toBe(2); // emit 2 was re-issued from `finally`
    expect(shutdownMock).toHaveBeenCalledTimes(1);
    expect(shutdownMock).toHaveBeenCalledWith({
      perSessionTimeoutMs: 2_000,
      hostTimeoutMs: 2_000,
    });
    expect(quit).toHaveBeenCalledTimes(1); // single re-issue from `finally`
    expect(peerCalls).toBe(2); // peer saw emit 1 and emit 2
    expect(peerPreventedOn).toStrictEqual([2]); // peer cancelled emit 2

    // --- Emit 3: user retries quit later -----------------------------
    // The peer cancelled emit 2, so the app is still alive. Our
    // handler must re-enter the drain path because `drainCompleted`
    // was cleared on emit 2's re-entry branch.
    const third = emitWillQuit();
    expect(third.defaultPrevented).toBe(true); // re-entered drain — preventDefault again
    expect(emitCount).toBe(3);

    await flushAsyncQuitChain();

    // The discriminating assertion: a second `shutdown` call proves
    // emit 3 re-entered the drain path. Without the
    // `drainCompleted = false` clear at the re-entry branch, our
    // handler would short-circuit at the top guard and `shutdownMock`
    // would still be at 1. `PtyHost.shutdown()` memoization (both
    // `NodePtyHost.shutdownPromise` and `RustSidecarPtyHost`'s
    // equivalent) makes the second call cheap — returns the cached
    // `DrainResult` instantly — so re-entry is safe by construction.
    expect(shutdownMock).toHaveBeenCalledTimes(2);
    // emit 4 was re-issued from emit 3's `finally`, bringing emit
    // count to 4 and `app.quit` invocations to 2.
    expect(emitCount).toBe(4);
    expect(quit).toHaveBeenCalledTimes(2);
    // The peer only `preventDefault`s on its second call — the
    // counter has since advanced past that (call #4 on emit 4), so
    // the second drain cycle proceeds unimpeded.
    expect(peerPreventedOn).toStrictEqual([2]);
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
