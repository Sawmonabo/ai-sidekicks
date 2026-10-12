// The smoke probe. The caller's compile-time `__SMOKE_BUILD__` gate means a release
// build references nothing here and, with no top-level side effects, Rollup drops the whole
// module from `out/main/index.js`.

import { setTimeout as wait } from "node:timers/promises";

import { app, net, type WebContents } from "electron";

import {
  READINESS_BREADCRUMB_TAG,
  SMOKE_PROBE_TAG,
  SMOKE_WORKER_SCRIPT_ENV,
} from "#shared/probe-tags.js";

import { RENDERER_INDEX_URL } from "../services/renderer/scheme.js";

/** Exit status when a reading from the console document or its first window failed. */
const READING_FAILED_EXIT_CODE = 2;

/** Exit status when the served `index.html` could not be fetched back for its policy header. */
const INDEX_FETCH_FAILED_EXIT_CODE = 4;

/**
 * How long the probe waits for the console document to open its first window, so a document that
 * opens none ends in a tagged line before the harness gives up on the launch.
 */
const FIRST_WINDOW_DEADLINE_MS = 10_000;

/** Per-invocation opt-in for the breadcrumb trail. */
const READINESS_TRACE_ENV = "SIDEKICKS_SMOKE_TRACE_READINESS";

/** Records one readiness milestone with its offset from the probe's start. */
export type ReadinessTracer = (readinessEvent: string) => void;

/**
 * Registers the pre-load readiness listener and returns the tracer for the milestones the
 * caller reaches itself. Call it from the window factory's `beforeLoad` hook with the window's
 * document: the load starts inside the factory, so registering there means a fast load cannot
 * miss a breadcrumb. With tracing off the tracer is a no-op.
 */
export function installReadinessBreadcrumbs(
  webContents: WebContents,
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

  webContents.once("dom-ready", () => {
    traceReadiness("dom-ready");
  });

  return traceReadiness;
}

/**
 * Runs the smoke probe once the real renderer bundle has finished loading, then exits the
 * process. Four readings from the trusted side ride one stdout line: `executeJavaScript`
 * against the console document (bridge present; `require`, `process`, `global` absent; the
 * privileged scheme's origin properties: protocol, host, `indexedDB`, a `localStorage`
 * round-trip), the same against the first window it opens (a mounted React tree, which the
 * console document draws there), the console document starting the renderer's worker script from
 * the served bundle under its policy and reading one reply, and `net.fetch` of the served
 * `index.html` to read back the `Content-Security-Policy` header, which is the policy's only
 * carrier.
 *
 * The window expression watches the root, for at most three seconds, because React's initial
 * render is not guaranteed to have flushed when the window opens. The probe runs on the
 * trusted side because CDP attachment is too heavy and renderer `console.log` parsing would
 * couple untrusted product code to the test mechanism.
 */
export async function runSmokeProbe(
  webContents: WebContents,
  firstWindowContents: Promise<WebContents>,
  windowMs: number,
): Promise<void> {
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
      return JSON.stringify({
        desktopBridge: typeof window.desktopBridge,
        require: typeof window.require,
        process: typeof window.process,
        global: typeof window.global,
        protocol: window.location.protocol,
        host: window.location.host,
        indexedDB: typeof window.indexedDB,
        localStorageRoundTrip: readLocalStorage(),
      });
    })()
  `;
  const windowReadings = `
    new Promise((resolve) => {
      const rootElement = document.getElementById("root");
      if (rootElement === null || rootElement.childElementCount > 0) {
        resolve(rootElement === null ? 0 : rootElement.childElementCount);
        return;
      }
      const observer = new MutationObserver(() => {
        if (rootElement.childElementCount > 0) {
          observer.disconnect();
          window.clearTimeout(deadline);
          resolve(rootElement.childElementCount);
        }
      });
      observer.observe(rootElement, { childList: true });
      const deadline = window.setTimeout(() => {
        observer.disconnect();
        resolve(rootElement.childElementCount);
      }, 3000);
    })
  `;

  const workerScript = process.env[SMOKE_WORKER_SCRIPT_ENV];
  if (workerScript === undefined) {
    console.error(`${SMOKE_PROBE_TAG} ${SMOKE_WORKER_SCRIPT_ENV} names no worker script`);
    app.exit(READING_FAILED_EXIT_CODE);
    return;
  }
  // One replaced pair, posted as the window's alignment worker posts it; a script the policy or
  // the scheme refuses fails with an error event instead.
  const workerReading = `
    new Promise((resolve) => {
      const worker = new Worker(new URL(${JSON.stringify(workerScript)}, window.location.href));
      const settle = (reading) => {
        window.clearTimeout(deadline);
        worker.terminate();
        resolve(reading);
      };
      const deadline = window.setTimeout(() => {
        settle({ failure: "the worker never answered" });
      }, 3000);
      worker.addEventListener("message", (event) => {
        settle({ reply: event.data });
      });
      worker.addEventListener("error", (event) => {
        settle({ failure: event.message || "the worker script did not load" });
      });
      worker.postMessage({
        requestId: 1,
        previousText: "const value = previousBudget;",
        nextText: "const value = nextBudget;",
      });
    })
  `;

  let serializedReadings: string;
  try {
    serializedReadings = (await webContents.executeJavaScript(rendererReadings)) as string;
  } catch (error: unknown) {
    console.error(`${SMOKE_PROBE_TAG} executeJavaScript failed:`, error);
    app.exit(READING_FAILED_EXIT_CODE);
    return;
  }

  let alignmentWorker: unknown;
  try {
    alignmentWorker = await webContents.executeJavaScript(workerReading);
  } catch (error: unknown) {
    console.error(`${SMOKE_PROBE_TAG} the worker reading failed:`, error);
    app.exit(READING_FAILED_EXIT_CODE);
    return;
  }

  // The process exits on every path below, so the losing timer needs no clearing.
  const firstWindow = await Promise.race([
    firstWindowContents,
    wait(FIRST_WINDOW_DEADLINE_MS, undefined),
  ]);
  if (firstWindow === undefined) {
    console.error(`${SMOKE_PROBE_TAG} the console document opened no window`);
    app.exit(READING_FAILED_EXIT_CODE);
    return;
  }

  let rootChildren: number;
  try {
    rootChildren = (await firstWindow.executeJavaScript(windowReadings)) as number;
  } catch (error: unknown) {
    console.error(`${SMOKE_PROBE_TAG} the window's executeJavaScript failed:`, error);
    app.exit(READING_FAILED_EXIT_CODE);
    return;
  }

  let contentSecurityPolicy: string | null;
  try {
    const indexResponse = await net.fetch(RENDERER_INDEX_URL);
    contentSecurityPolicy = indexResponse.headers.get("content-security-policy");
    // Release the streamed body rather than leaving the file handle open.
    await indexResponse.body?.cancel();
  } catch (error: unknown) {
    console.error(`${SMOKE_PROBE_TAG} index fetch failed:`, error);
    app.exit(INDEX_FETCH_FAILED_EXIT_CODE);
    return;
  }

  console.log(
    `${SMOKE_PROBE_TAG} ${JSON.stringify({
      ok: true,
      windowMs,
      probe: {
        ...(JSON.parse(serializedReadings) as Record<string, unknown>),
        rootChildren,
        alignmentWorker,
      },
      contentSecurityPolicy,
    })}`,
  );
  app.exit(0);
}
