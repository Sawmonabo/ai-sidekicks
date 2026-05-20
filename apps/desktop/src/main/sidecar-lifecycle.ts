// Electron main-process wiring for the sidecar-lifecycle drain.
//
// Plan-001 §Cross-Plan Obligations CP-001-1 (sidecar-cleanup handler
// registers BEFORE Electron `will-quit`) lives here. Under Electron's
// EventEmitter semantics, listener invocation order equals registration
// order — see I-024-4 in Plan-024 for the load-bearing FIFO invariant
// and the `microsoft/node-pty#904` SIGABRT-on-exit failure mode that
// motivates it. `registerSidecarLifecycle(app, getPtyHost)` MUST run
// before any other `app.on('will-quit', ...)` registration in
// `apps/desktop/src/main/index.ts`.
//
// The polymorphic drain protocol lives on `PtyHost.shutdown()` per
// `packages/contracts/src/pty-host.ts`. Both backends — the in-process
// `NodePtyHost` (macOS/Linux primary; Windows fallback) and the
// out-of-process `RustSidecarPtyHost` (Windows Phase 5 default) —
// implement the same interface, so this module never touches a
// backend-specific surface. ADR-019 §Decision item 8 line 48 declares
// "Consumers never see the backend choice" — that polymorphism contract
// is what lets this module stay backend-agnostic.
//
// Why the lazy getter (`() => PtyHost | null`) instead of an eager
// `PtyHost` argument: at module-load time the daemon's PtyHost has not
// been provisioned yet — the Electron main process registers the
// will-quit handler synchronously during startup, but the PtyHost is
// constructed later when the daemon's lifecycle finishes booting (the
// `runtime-daemon` package's bootstrap is not yet wired into the
// desktop entrypoint as of Plan-001 Phase 5). The lazy getter lets the
// will-quit handler defer the lookup until the quit signal fires, by
// which point the PtyHost either exists (drain) or has never been
// constructed (no-op cleanly). Shape A (lazy getter) over Shape B
// (eager construct-first) keeps the FIFO-ordering invariant
// unconditional — the handler ALWAYS registers at position 0,
// independent of whether the daemon has finished bootstrapping by the
// time the user triggers a quit.
//
// Re-entry guard rationale: Electron's `app.quit()` API re-fires
// `before-quit` + `will-quit` ("Try to close all windows. The
// `before-quit` event will be emitted first. If all windows are
// successfully closed, the `will-quit` event will be emitted and by
// default the application will terminate." — Electron docs,
// https://www.electronjs.org/docs/latest/api/app#appquit). When our
// will-quit handler completes the drain and re-issues `app.quit()` via
// `process.nextTick`, Electron emits `will-quit` a SECOND time. Without
// a guard, our handler would re-enter: getPtyHost() returns the same
// (now-drained) host, `event.preventDefault()` fires, shutdown() is
// invoked again, and `process.nextTick(() => app.quit())` schedules a
// third pass — an infinite re-entry loop. The closure-local
// `drainCompleted` flag short-circuits on the second emit so the
// downstream listener chain proceeds normally. `app.exit(0)` would
// avoid the loop by skipping the entire quit chain (per the same
// Electron docs: "the `before-quit` and `will-quit` events will not be
// emitted"), but that would BYPASS every downstream `will-quit` handler
// — destroying the FIFO chain contract this module exists to honor
// (Plan-024 §I-024-4 sits at the head of the chain precisely so peers
// can do their own cleanup AFTER the drain).
//
// Hard wall-clock cap rationale: the per-session + host budgets total
// 4 s by default, but a runaway `PtyHost.shutdown()` promise (host
// implementation regression, dropped IPC frame, deadlocked future) MUST
// NOT block Electron quit indefinitely. The drain is raced against a
// 5 s `setTimeout`-backed promise (`HARD_QUIT_CAP_MS`). On hard-cap
// expiry the handler logs loudly and still falls through to
// `app.quit()` so the user is not stranded. The cap is `.unref()`'d so
// the timer never keeps the Node event loop alive past `app.quit()`,
// and exposed as a `SidecarLifecycleDeps.hardCapMs` injection seam so
// the test can exercise the cap branch without a wall-clock wait.
//
// Refs:
//   • Plan-001 §Cross-Plan Obligations CP-001-1 — registration ordering
//     + drain orchestration contract; resolution at Phase 5 Lane D.
//   • Plan-024 §Invariants I-024-4 — primary FIFO + drain invariant.
//   • Plan-024 §Windows Implementation Gotchas Gotcha 4 — primary-
//     source citation (`microsoft/node-pty#904`).
//   • ADR-019 §Decision item 8 — backend polymorphism (no downcasting
//     to RustSidecarPtyHost from this layer).
//   • Electron app.quit() docs —
//     https://www.electronjs.org/docs/latest/api/app#appquit (re-entry
//     semantics that motivate the `drainCompleted` guard).

import type { App } from "electron";

import type { PtyHost, DrainResult } from "@ai-sidekicks/contracts";

/**
 * Timeout budgets (milliseconds) passed to `PtyHost.shutdown()` from
 * the will-quit handler.
 *
 * Plan-001 §CP-001-1 resolution declares "2 s per-session bounded
 * timeout" + "second bounded timeout: 2 s" for the sidecar host wind-
 * down; both budgets surface here so the wiring layer (this module)
 * owns the constant rather than scattering it across the contract /
 * implementation boundary.
 *
 * `perSessionTimeoutMs` dominates per-session child cleanup latency
 * (SIGTERM → ExitCodeNotification on the wire). `hostTimeoutMs`
 * dominates sidecar dispatcher wind-down latency (stdin EOF → reader
 * loop drain → process exit). The two are independent budgets so the
 * lifecycle layer can dimension each separately — e.g., the sidecar
 * itself runs SIGTERM → 2 s → SIGKILL per session in the kill-cascade,
 * so the per-session budget here must exceed that wall-clock budget to
 * observe the sidecar's own cascade resolving before the lifecycle
 * layer escalates.
 */
export interface SidecarLifecycleTimeouts {
  readonly perSessionTimeoutMs: number;
  readonly hostTimeoutMs: number;
}

/**
 * Default timeout budgets per Plan-001 §CP-001-1 resolution ("2 s
 * per-session bounded timeout; second bounded timeout: 2 s"). Exposed
 * as a named constant so call sites that override (e.g., a slow CI
 * profile) can compose against the canonical baseline rather than
 * re-deriving from the plan body.
 */
export const DEFAULT_SIDECAR_LIFECYCLE_TIMEOUTS: SidecarLifecycleTimeouts = {
  perSessionTimeoutMs: 2_000,
  hostTimeoutMs: 2_000,
};

/**
 * Hard wall-clock cap (milliseconds) on the will-quit drain. Defense
 * in depth — the underlying per-session + host budgets total 4 s by
 * default, but a runaway `PtyHost.shutdown()` promise must not block
 * Electron's quit indefinitely. On expiry the handler logs an error
 * and proceeds with `app.quit()` so the user is not stranded.
 *
 * Module-internal (no `export`) per the T5.3 round-3 constraint that
 * only `SidecarLifecycleDeps` gains a new field on this round trip.
 * Overridable per-call via `SidecarLifecycleDeps.hardCapMs` (used by
 * tests to exercise the cap branch without a wall-clock wait).
 */
const HARD_QUIT_CAP_MS = 5_000 as const;

/**
 * Lazy getter shape — returns the active `PtyHost` instance if one has
 * been provisioned, or `null` if the daemon has not yet constructed
 * one at the moment the will-quit handler fires.
 *
 * The `null` case is a clean no-op rather than an error: if no PtyHost
 * exists, there are no sessions to drain and no sidecar to wind down,
 * so the will-quit handler returns immediately and Electron continues
 * its teardown sequence. Surfacing this as a getter rather than an
 * eager argument lets `registerSidecarLifecycle` run unconditionally
 * at startup (preserving the FIFO-ordering invariant) even when the
 * daemon's PtyHost provisioning is async / deferred.
 */
export type PtyHostGetter = () => PtyHost | null;

/**
 * Optional dependency injection seam — keeps the production call site
 * (`app.on(...)` + `event.preventDefault()` + `process.nextTick(app.quit)`)
 * unit-testable without needing Electron at test time.
 */
export interface SidecarLifecycleDeps {
  /**
   * Override the per-session + host timeout budgets. Defaults to
   * `DEFAULT_SIDECAR_LIFECYCLE_TIMEOUTS`. Tests pass small values to
   * exercise the timeout branches without wall-clock waits.
   */
  readonly timeouts?: SidecarLifecycleTimeouts;
  /**
   * Override the diagnostic logger. Defaults to `console`; tests pass
   * a recording double so an empty-PtyHost / drain-error / timeout-
   * escalation branch can be asserted without spying on the global
   * `console` namespace.
   */
  readonly logger?: Pick<Console, "warn" | "error" | "info">;
  /**
   * Override the hard wall-clock cap (ms) on the drain. Defaults to
   * `HARD_QUIT_CAP_MS` (5_000). Tests pass small values (e.g. 50 ms)
   * to exercise the hard-cap branch without a real-time 5 s wait.
   */
  readonly hardCapMs?: number;
}

/**
 * Register the sidecar-lifecycle drain handler on Electron `app`'s
 * `will-quit` event.
 *
 * MUST be called BEFORE any other `app.on('will-quit', ...)`
 * registration in `apps/desktop/src/main/index.ts` so the FIFO
 * registration-order invariant (Plan-024 §I-024-4) holds — under
 * Electron's EventEmitter semantics, the first-registered listener
 * runs first, and the drain MUST complete (or escalate) before any
 * downstream handler closes resources the drain depends on.
 *
 * Drain orchestration:
 *   1. The handler intercepts `will-quit` and (a) reads the current
 *      `PtyHost` via the lazy getter — returns immediately on `null`
 *      so the bootstrap-time invocation is a clean no-op; (b) calls
 *      `PtyHost.shutdown({ perSessionTimeoutMs, hostTimeoutMs })`
 *      which runs the per-session SIGTERM → SIGKILL escalation AND
 *      the sidecar-process wind-down + taskkill escalation; (c)
 *      reports the `DrainResult` to the diagnostic logger so an
 *      operator can observe whether sessions drained cleanly or were
 *      force-killed.
 *   2. The handler is async, but Electron's `will-quit` is a sync
 *      EventEmitter event — to keep quit-blocking semantics correct,
 *      the handler calls `event.preventDefault()` synchronously, runs
 *      the async drain (raced against a 5 s hard wall-clock cap so a
 *      runaway shutdown() promise cannot block quit indefinitely), and
 *      re-issues `app.quit()` on completion via `process.nextTick` so
 *      the next-iteration emit progresses past this handler. This is
 *      the canonical Electron pattern for async work in `will-quit` —
 *      see Electron's `will-quit` docs.
 *   3. Re-entry guard: the second emit of `will-quit` (triggered by
 *      our own `app.quit()` re-issue) MUST short-circuit so the
 *      downstream chain proceeds without another drain pass. A
 *      closure-local `drainCompleted` flag flips to `true` once the
 *      drain (or the no-op branch) completes; subsequent emits return
 *      early without calling `event.preventDefault()`. See the module-
 *      level re-entry-guard comment for the load-bearing rationale.
 *
 * Backend polymorphism: the handler calls `shutdown()` on the
 * `PtyHost` interface — never on a backend-specific class. ADR-019
 * §Decision item 8 line 48 declares "Consumers never see the backend
 * choice"; this module is the consumer-side enforcement of that
 * invariant on the lifecycle axis.
 *
 * @param app - The Electron `App` instance whose `will-quit` slot
 *   receives the registration.
 * @param getPtyHost - Lazy getter that returns the active PtyHost (or
 *   `null` if no host has been provisioned yet). See `PtyHostGetter`
 *   rustdoc for the bootstrap-ordering rationale.
 * @param deps - Optional dependency-injection seam for tests. Default
 *   timeouts + `console` logger + `HARD_QUIT_CAP_MS` hard cap when
 *   omitted.
 */
export function registerSidecarLifecycle(
  app: App,
  getPtyHost: PtyHostGetter,
  deps: SidecarLifecycleDeps = {},
): void {
  const timeouts: SidecarLifecycleTimeouts = deps.timeouts ?? DEFAULT_SIDECAR_LIFECYCLE_TIMEOUTS;
  const logger: Pick<Console, "warn" | "error" | "info"> = deps.logger ?? console;
  const hardCapMs: number = deps.hardCapMs ?? HARD_QUIT_CAP_MS;

  // Closure-local guard: flips to `true` once the drain (or the no-op
  // branch) has completed. The will-quit handler short-circuits on
  // re-entry so the second `app.quit()` issued from `process.nextTick`
  // below does NOT trigger another drain pass — see module-level
  // re-entry-guard comment for the Electron-docs citation that
  // motivates this pattern.
  let drainCompleted = false;

  app.on("will-quit", (event) => {
    if (drainCompleted) {
      // Re-entry from the post-drain `app.quit()` re-issue. Let
      // Electron's quit chain proceed past our handler — no
      // preventDefault, no shutdown call, no re-issued quit.
      return;
    }

    const ptyHost: PtyHost | null = getPtyHost();
    if (ptyHost === null) {
      // No daemon PtyHost has been provisioned yet — nothing to drain,
      // nothing to wind down. The will-quit chain proceeds via the
      // downstream handlers without interruption. This is the
      // bootstrap-window case (Electron quits before the daemon has
      // finished booting), which is benign. Flip `drainCompleted`
      // anyway so any future re-emit (defensive — Electron wouldn't
      // re-emit on its own without our `app.quit()` re-issue, but a
      // peer handler could call `app.quit()` for its own reasons) also
      // short-circuits cleanly.
      drainCompleted = true;
      logger.info(
        "[sidecar-lifecycle] will-quit fired with no PtyHost provisioned; " + "no-op drain.",
      );
      return;
    }

    // Async drain — Electron's `will-quit` is a synchronous
    // EventEmitter event, but `PtyHost.shutdown()` is async. The
    // canonical pattern: prevent the default (which stops the quit
    // sequence), run the async drain, then re-issue `app.quit()`
    // from a separate tick so the listener queue advances past us.
    event.preventDefault();

    void (async (): Promise<void> => {
      try {
        // Race the drain against a hard wall-clock cap so a runaway
        // `shutdown()` promise cannot block Electron's quit
        // indefinitely. `.unref()` the timer so it doesn't keep the
        // Node event loop alive past `app.quit()`.
        const drainPromise: Promise<DrainResult> = ptyHost.shutdown(timeouts);
        const hardCapPromise: Promise<"hard-cap-fired"> = new Promise((resolve) => {
          setTimeout(() => {
            resolve("hard-cap-fired");
          }, hardCapMs).unref();
        });

        const raceResult: DrainResult | "hard-cap-fired" = await Promise.race([
          drainPromise,
          hardCapPromise,
        ]);

        if (raceResult === "hard-cap-fired") {
          logger.error(
            `[sidecar-lifecycle] PtyHost.shutdown() did not resolve within ` +
              `${hardCapMs.toString()} ms; proceeding with Electron quit ` +
              `to avoid stranding the user.`,
          );
        } else {
          logger.info(
            `[sidecar-lifecycle] drain complete: ` +
              `${raceResult.sessionsDrained.toString()} drained, ` +
              `${raceResult.sessionsForcedKilled.toString()} forced; ` +
              `sidecar exited cleanly=${String(raceResult.sidecarExitedCleanly)}, ` +
              `taskkill escalated=${String(raceResult.taskkillEscalated)}.`,
          );
        }
      } catch (err: unknown) {
        // Drain throwing is a defense-in-depth path — the production
        // `shutdown()` implementations swallow per-session and host
        // errors internally and surface them via the DrainResult
        // flags. A throw here is a bug or a future-evolution surface;
        // log loudly and let Electron continue with quit so the user
        // is not stranded in a hung session.
        const message: string = err instanceof Error ? err.message : String(err);
        logger.error(
          `[sidecar-lifecycle] PtyHost.shutdown() threw unexpectedly: ${message}; ` +
            `proceeding with Electron quit so the user is not stranded.`,
        );
      } finally {
        // ORDER MATTERS: flip the guard BEFORE re-issuing `app.quit()`.
        // The re-issued quit re-emits `will-quit` synchronously enough
        // that the guard must already be `true` when the next emit
        // dispatches our handler — otherwise we'd recurse.
        drainCompleted = true;
        // Re-issue quit so the listener queue advances. nextTick
        // schedules synchronously-after this handler completes, which
        // ensures the prevent-default did its job (the original
        // will-quit emit pass is no longer in progress).
        process.nextTick(() => {
          app.quit();
        });
      }
    })();
  });
}
