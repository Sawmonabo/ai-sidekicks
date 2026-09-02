// The substrate-boots smoke probe — Plan-023 Phase 1B (T-023p-1B-2).
//
// Lives beside the entrypoint rather than inside it. `index.ts` is the startup
// ORDER — scheme, lock, ready, protocol, menu, window — and a reader checking
// that order should not have to page past ninety lines of probe body to find
// the next step of it. What stays in `index.ts` is the one gated call.
//
// PRODUCTION SAFETY is unchanged by the move, and slightly strengthened. The
// caller's `__SIDEKICKS_SMOKE_BUILD__` gate is a compile-time-static identifier
// Vite substitutes with the literal `false` in a default `electron-vite build`,
// so the call collapses to dead code and Rollup strips it — and because this
// module is then referenced by nothing and declares only a `const` and a
// `function` (no top-level side effects), Rollup drops the whole module from
// `out/main/index.js` rather than merely the call. `grep -c
// SIDEKICKS_SMOKE_PROBE out/main/index.js` returns 0 for a release build, which
// the smoke suite asserts against the smoke bundle — the one where the body
// actually survives.

import { app, net, type BrowserWindow } from "electron";

import { RENDERER_INDEX_URL } from "../protocol.js";

/** The stdout marker `apps/desktop/test/launch.smoke.test.ts` parses. */
export const SMOKE_PROBE_TAG = "[SIDEKICKS_SMOKE_PROBE]";

/**
 * The stderr marker for the corroborating readiness breadcrumbs.
 *
 * `did-finish-load` stays the ONLY signal the smoke test asserts on. These
 * record how far the boot got when the probe line never arrives, which turns
 * one indistinguishable timeout into several distinguishable ones. Kept off
 * stdout so the harness's probe-line scanner still sees exactly one tagged
 * line there.
 */
export const READINESS_BREADCRUMB_TAG = "[SIDEKICKS_SMOKE_READY]";

/** Per-invocation opt-in for the breadcrumb trail. */
const READINESS_TRACE_ENV = "SIDEKICKS_SMOKE_TRACE_READINESS";

/** Records one readiness milestone with its offset from the probe's start. */
export type ReadinessTracer = (readinessEvent: string) => void;

/**
 * Registers the pre-load readiness listeners and returns the tracer for the
 * milestones the caller reaches itself.
 *
 * Call it from the window factory's `beforeLoad` hook: the load starts inside
 * the factory, so registering there is what makes "no breadcrumb can be missed
 * by a fast load" a structural property rather than a timing accident.
 *
 * `dom-ready` is a `webContents` event and `ready-to-show` is a `BrowserWindow`
 * event, so they are registered on their own emitters rather than through one
 * loop — a wrong-emitter registration is then a compile error instead of a
 * listener that never fires.
 *
 * With tracing off the returned tracer is a no-op, so the caller has no second
 * gate to keep in step with this one.
 */
export function installReadinessBreadcrumbs(
  browserWindow: BrowserWindow,
  probeStartedAt: number,
): ReadinessTracer {
  if (process.env[READINESS_TRACE_ENV] !== "1") {
    return () => {
      // Tracing is off: record nothing.
    };
  }

  const traceReadiness: ReadinessTracer = (readinessEvent) => {
    console.error(
      `${READINESS_BREADCRUMB_TAG} ${readinessEvent} +${String(Date.now() - probeStartedAt)}ms`,
    );
  };

  browserWindow.webContents.once("dom-ready", () => {
    traceReadiness("dom-ready");
  });
  browserWindow.once("ready-to-show", () => {
    traceReadiness("ready-to-show");
  });

  return traceReadiness;
}

/**
 * Runs the smoke probe once the REAL renderer bundle has finished loading, then
 * exits the process.
 *
 * Two readings, both taken from the trusted side:
 *
 *   1. `executeJavaScript` against the renderer, asserting the
 *      `Spec-023 §Security Hardening Baseline` runtime invariants (bridge
 *      present; `require` / `process` / `global` all absent) AND the origin
 *      properties Phase 1B's privileged scheme is what makes true — the
 *      `sidekicks-renderer:` protocol, the `app` host, a live `indexedDB`, a
 *      `localStorage` round-trip, and a mounted React tree. A scheme registered
 *      without `standard: true` has no origin, so the storage readings would be
 *      the first thing to fail (Plan-023 I-023-11).
 *   2. `net.fetch` from the main process against the served `index.html`, to
 *      read back the `Content-Security-Policy` header the handler attaches. The
 *      header is the policy's ONLY carrier — the shipped `index.html` has no
 *      meta tag — so a header that silently stopped being attached would
 *      otherwise be invisible to every automated check.
 *
 * Both readings ride ONE stdout line so the test parses one JSON object.
 *
 * The renderer expression resolves a promise rather than reading `#root`
 * synchronously: React 19's `createRoot().render()` schedules the initial mount
 * through the Scheduler's `MessageChannel` task, which is not guaranteed to have
 * flushed by `did-finish-load`. The wait is bounded and its timer is cleared on
 * every exit path, so an unmounted tree fails the assertion instead of hanging
 * the probe.
 *
 * The probe mechanism lives on the trusted side deliberately. External CDP /
 * `chrome-remote-interface` attachment was rejected at Tier 1 (too heavyweight;
 * a new dependency family), and renderer `console.log` parsing was rejected
 * because renderer source is untrusted per `Spec-023 §Trust Stance` — adding a
 * probe there would couple a non-test surface to the test mechanism.
 */
export async function runSmokeProbe(browserWindow: BrowserWindow, windowMs: number): Promise<void> {
  const rendererReadings = `
    (() => {
      const readLocalStorage = () => {
        try {
          const probeKey = "__sidekicks_smoke_probe__";
          window.localStorage.setItem(probeKey, "ok");
          const readBack = window.localStorage.getItem(probeKey);
          window.localStorage.removeItem(probeKey);
          return readBack === "ok";
        } catch {
          return false;
        }
      };
      const rootChildren = () =>
        new Promise((resolve) => {
          const deadline = Date.now() + 3000;
          const poll = () => {
            const rootElement = document.getElementById("root");
            const childCount = rootElement === null ? 0 : rootElement.childElementCount;
            if (childCount > 0 || Date.now() >= deadline) {
              resolve(childCount);
              return;
            }
            window.setTimeout(poll, 25);
          };
          poll();
        });
      return rootChildren().then((childCount) =>
        JSON.stringify({
          sidekicks: typeof window.sidekicks,
          require: typeof window.require,
          process: typeof window.process,
          global: typeof window.global,
          protocol: window.location.protocol,
          host: window.location.host,
          indexedDB: typeof window.indexedDB,
          localStorageRoundTrip: readLocalStorage(),
          rootChildren: childCount,
        }),
      );
    })()
  `;

  let serialisedReadings: string;
  try {
    serialisedReadings = (await browserWindow.webContents.executeJavaScript(
      rendererReadings,
    )) as string;
  } catch (error: unknown) {
    console.error(`${SMOKE_PROBE_TAG} executeJavaScript failed:`, error);
    app.exit(2);
    return;
  }

  let contentSecurityPolicy: string | null;
  try {
    const indexResponse = await net.fetch(RENDERER_INDEX_URL);
    contentSecurityPolicy = indexResponse.headers.get("content-security-policy");
    // Release the streamed body rather than leaving the file handle open for
    // the (short) remainder of the process's life.
    await indexResponse.body?.cancel();
  } catch (error: unknown) {
    console.error(`${SMOKE_PROBE_TAG} index fetch failed:`, error);
    app.exit(4);
    return;
  }

  console.log(
    `${SMOKE_PROBE_TAG} ${JSON.stringify({
      ok: true,
      windowMs,
      probe: JSON.parse(serialisedReadings) as Record<string, unknown>,
      contentSecurityPolicy,
    })}`,
  );
  app.exit(0);
}
