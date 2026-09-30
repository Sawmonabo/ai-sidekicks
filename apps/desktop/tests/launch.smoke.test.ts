// Smoke test: boots the built Electron smoke bundle and asserts the runtime security invariants.
// The main entry's smoke branch (gated on `SIDEKICKS_SMOKE_PROBE=1`) runs `executeJavaScript` from
// the trusted main process, prints one tagged JSON line and exits, and this test parses that
// line, so no probe lives in the untrusted renderer.
//
// It runs against the smoke bundle (`electron-vite build --mode=smoke`, a dependency of
// `test:smoke`), never the release bundle, which tree-shakes the probe branch out. The invariants
// (`desktopBridge` defined; `require`, `process` and `global` undefined) hold identically in the
// release bundle: the probe only adds the readout to the document a release build loads. Every
// spawn gets a private profile via `--user-data-dir`: a concurrent default-profile Electron would
// hold the `SingletonLock`, and this spawn would quit before a window and exit 0 without a probe
// line (see `spawnElectron()`).
// CI exports `$DISPLAY` once one job-level Xvfb signals ready on `-displayfd` (see
// `.github/workflows/ci.yml`); a Linux contributor without one falls back to `xvfb-run -a`.
//
// `out/main/index.js` is ESM (Electron supports an ESM main since v28) and
// `out/preload/index.cjs` is CommonJS because a sandboxed preload cannot be ESM; the decision log
// is the header of `electron.vite.config.ts`.

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SMOKE_PROBE_TAG } from "@shared/probe-tags.js";

import {
  BOOT_TEST_TIMEOUT_MS,
  MAIN_ENTRY,
  spawnElectron,
  WINDOW_BUDGET_MS,
} from "./helpers/smoke-probe-harness.js";
import { renderReadinessFailure } from "./helpers/smoke-probe-diagnosis.js";

describe("desktop main process boot", () => {
  // Asserts the preload bridge registered and no Node global reached the renderer.
  it(
    "renderer exposes the preload bridge and leaks no Node globals",
    async () => {
      const result = await spawnElectron();

      // Surface the full dump when no probe line arrived, so a failure is attributable from one
      // read of the CI log: the readiness events that fired, the environment readings, and both
      // raw streams.
      if (!result.probe) {
        throw new Error(renderReadinessFailure(result));
      }

      const probe = result.probe;

      // Invariant 1: `windowMs` runs from `app.whenReady()` to `did-finish-load` on the real
      // bundle served over `sidekicks-renderer://`, so the budget covers the handler and the
      // bundle.
      expect(probe.ok).toBe(true);
      expect(probe.windowMs).toBeLessThanOrEqual(WINDOW_BUDGET_MS);

      // Invariant 2: the preload exposed `desktopBridge` in the main world. A misconfigured
      // `contextIsolation`, `sandbox` or preload path would read `"undefined"`.
      expect(probe.probe.desktopBridge).toBe("object");

      // Invariant 3: no Node API leak. `"function"` here means `nodeIntegration: true` slipped
      // past the lint rules.
      expect(probe.probe.require).toBe("undefined");

      // Invariant 4: `window.process` is `undefined`.
      expect(probe.probe.process).toBe("undefined");

      // Invariant 5: `window.global` is `undefined`, the third Node-API-leak global.
      expect(probe.probe.global).toBe("undefined");

      // Invariant 6: the document came from the privileged scheme at the `app` host, which
      // separates "a window exists" from "the bundle is served".
      expect(probe.probe.protocol).toBe("sidekicks-renderer:");
      expect(probe.probe.host).toBe("app");

      // Invariant 7: the origin carries storage. A scheme registered without `standard: true`
      // still loads documents but has an opaque origin: `indexedDB` is absent and `localStorage`
      // throws. The persisted UI state (layout, scroll, selection, pins) lives there, so a
      // regression would show as data that never survives a restart.
      expect(probe.probe.indexedDB).toBe("object");
      expect(probe.probe.localStorageRoundTrip).toBe(true);

      // Invariant 8: the React tree mounted. `did-finish-load` fires on the document, so a bundle
      // whose entry chunk 404'd would pass every assertion above.
      expect(probe.probe.rootChildren).toBeGreaterThan(0);

      // Invariant 9: the CSP header rides the response. It is the policy's only carrier
      // (`index.html` ships no meta tag), so nothing else would notice it disappearing. It is read
      // from the main process via `net.fetch`, since a renderer cannot read its own response
      // headers.
      expect(probe.contentSecurityPolicy).not.toBeNull();
      const contentSecurityPolicy = probe.contentSecurityPolicy ?? "";
      for (const directive of [
        "default-src 'self'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ]) {
        expect(contentSecurityPolicy).toContain(directive);
      }
      // Nothing may admit remote script or a wildcard origin; the presence checks above would not
      // catch a widened directive appended beside them.
      expect(contentSecurityPolicy).not.toContain("unsafe-eval");
      expect(contentSecurityPolicy).not.toContain("*");
      expect(contentSecurityPolicy).not.toContain("http://");

      // The probe branch exits via `app.exit(0)`; a signal or non-zero exit means the boot failed.
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
    },
    // Derived from the phases it contains; see BOOT_TEST_TIMEOUT_MS.
    BOOT_TEST_TIMEOUT_MS,
  );

  // No blank-document load ships. The smoke bundle is the one build where the probe body
  // survives (a release bundle tree-shakes the branch), so checking it is the only form of this
  // assertion with force. A re-introduced blank-document load would fail other assertions for a
  // reason nobody would read as a revert; this says it directly.
  it("ships no blank-document load in the built smoke bundle", () => {
    expect(
      existsSync(MAIN_ENTRY),
      `Main entry missing at ${MAIN_ENTRY}. Run \`pnpm --filter @ai-sidekicks/desktop test\` (which rebuilds the smoke bundle).`,
    ).toBe(true);

    const builtMainBundle = readFileSync(MAIN_ENTRY, "utf8");

    expect(builtMainBundle).not.toContain("about:blank");
    // Positive control: the probe body is present, so the absence above is real and not a wrong
    // path or a tree-shaken release bundle.
    expect(builtMainBundle).toContain(SMOKE_PROBE_TAG);
    expect(builtMainBundle).toContain("sidekicks-renderer://app/index.html");
  });
});
