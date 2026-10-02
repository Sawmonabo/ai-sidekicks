// The smoke probe. The caller's compile-time `__SMOKE_BUILD__` gate means a release
// build references nothing here and, with no top-level side effects, Rollup drops the whole
// module from `out/main/index.js`.

import { app, net, type BrowserWindow } from "electron";

import { READINESS_BREADCRUMB_TAG, SMOKE_PROBE_TAG } from "@shared/probe-tags.js";

import { RENDERER_INDEX_URL } from "../services/renderer-scheme.js";

/** Per-invocation opt-in for the breadcrumb trail. */
const READINESS_TRACE_ENV = "SIDEKICKS_SMOKE_TRACE_READINESS";

/** Records one readiness milestone with its offset from the probe's start. */
export type ReadinessTracer = (readinessEvent: string) => void;

/**
 * Registers the pre-load readiness listeners and returns the tracer for the milestones the
 * caller reaches itself. Call it from the window factory's `beforeLoad` hook: the load starts
 * inside the factory, so registering there means a fast load cannot miss a breadcrumb.
 * `dom-ready` and `ready-to-show` are registered on their own emitters, so a wrong emitter
 * is a compile error. With tracing off the tracer is a no-op.
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
 * Runs the smoke probe once the real renderer bundle has finished loading, then exits the
 * process. Two readings from the trusted side ride one stdout line: `executeJavaScript`
 * against the renderer (bridge present; `require`, `process`, `global` absent; the
 * privileged scheme's origin properties: protocol, host, `indexedDB`, a `localStorage`
 * round-trip, a mounted React tree), and `net.fetch` of the served `index.html` to read back
 * the `Content-Security-Policy` header, which is the policy's only carrier.
 *
 * The renderer expression watches the root, for at most three seconds, because React's initial
 * render is not guaranteed to have flushed at `did-finish-load`. The probe runs on the
 * trusted side because CDP attachment is too heavy and renderer `console.log` parsing would
 * couple untrusted product code to the test mechanism.
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
        });
      return rootChildren().then((childCount) =>
        JSON.stringify({
          desktopBridge: typeof window.desktopBridge,
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

  let serializedReadings: string;
  try {
    serializedReadings = (await browserWindow.webContents.executeJavaScript(
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
    // Release the streamed body rather than leaving the file handle open.
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
      probe: JSON.parse(serializedReadings) as Record<string, unknown>,
      contentSecurityPolicy,
    })}`,
  );
  app.exit(0);
}
