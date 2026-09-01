// Plan-023 Phase 1 T-023p-1-7 — Vitest substrate-boots smoke test.
//
// Tier 1 unblock proof: programmatically spawns the built Electron bundle
// against `apps/desktop/src/main/index.ts`'s `SIDEKICKS_SMOKE_PROBE=1`
// branch and asserts the Spec-023 §Security Hardening Baseline runtime
// invariants:
//
//   1. The main window's renderer document loads within 5 seconds.
//   2. `window.sidekicks` is defined (the preload bridge from T-023p-1-4
//      actually registered on the renderer surface — i.e., the
//      `contextBridge.exposeInMainWorld` call ran).
//   3. `window.require` is `undefined` (the Spec-023 §Security Hardening
//      Baseline `nodeIntegration: false` + `sandbox: true` combination
//      successfully prevented any Node API leak into the renderer).
//   4. `window.process` is `undefined` — the second of the three Node-
//      API-leak globals named by `Spec-023 §Acceptance Criteria`.
//   5. `window.global` is `undefined` — the third Node-API-leak global
//      named by `Spec-023 §Acceptance Criteria`. With this third
//      assertion the Tier 1 smoke covers the full `Spec-023 §Acceptance Criteria` set
//      (`require` / `process` / `global`); the Tier 8 Playwright E2E
//      suite repeats the assertion across packaged-binary surfaces, but
//      the Tier 1 substrate is the load-bearing single-source-of-truth.
//
// Why Vitest, not Playwright:
//   Plan-023 §Implementation Steps step 18 + §Test And Verification Plan
//   defer the Playwright `_electron` E2E suite to Tier 8 remainder. Tier 1
//   ships only this single Vitest-driven smoke test as the substrate-boots
//   proof; the heavier `@playwright/test` dep is a Tier 8 lift.
//
// Mechanism — Option (ii) in the T-023p-1-7 dispatch contract:
//   The renderer is renderer-untrusted (Spec-023 §Trust Stance), so we do
//   NOT add a probe to the renderer source. Instead, the main entrypoint
//   has a smoke-mode branch gated on `SIDEKICKS_SMOKE_PROBE=1` that calls
//   `webContents.executeJavaScript(...)` from the trusted main process,
//   prints a single-line tagged JSON payload to stdout, and exits. This
//   test parses that line.
//
// Linux CI handling — Option A in the T-023p-1-7 dispatch contract:
//   GitHub Actions `ubuntu-latest` has no display server but ships
//   `xvfb-run` preinstalled. When the test runs on Linux without
//   `$DISPLAY`, we prepend `xvfb-run -a` so the Electron Chromium boot
//   succeeds against a virtual framebuffer. macOS and Windows runners
//   spawn `electron` directly. This keeps Linux as active CI coverage
//   (the DAG-preferred posture).
//
// Profile isolation:
//   Every spawn gets a private Chromium profile via `--user-data-dir`.
//   Electron's DEFAULT profile carries a machine-wide `SingletonLock`, so any
//   concurrent default-profile Electron — a second checkout running this same
//   suite, a developer's unrelated Electron app, an orphan from an earlier
//   terminated run — would make this spawn lose
//   `app.requestSingleInstanceLock()` and quit before booting a window,
//   emitting no probe line and exiting 0. That was this test's historical
//   flake; see `spawnElectron()` for the mechanism and its reproduction.
//
// Build precondition:
//   This test runs against the SMOKE bundle (`electron-vite build
//   --mode=smoke`), NOT the release bundle (`electron-vite build`). The
//   release bundle tree-shakes the smoke-probe branch out of
//   `out/main/index.js` entirely (the production-safety guarantee — see
//   `apps/desktop/src/main/index.ts` header and `electron.vite.config.ts`
//   `define` block); attempting to run this test against a release bundle
//   would hang waiting for a probe line that physically does not exist in
//   the binary.
//
//   `apps/desktop/package.json`'s `test` script self-orchestrates the
//   smoke build: it runs `pnpm run build:smoke` before invoking vitest,
//   so a developer running `pnpm --filter @ai-sidekicks/desktop test`
//   does not need a separate build step. The existsSync fail-fast
//   diagnostics below suggest `pnpm test` (which rebuilds the smoke
//   bundle) instead of `pnpm build` (which would produce a probe-less
//   release bundle that this test cannot use).
//
// Module-system shape (verified empirically at T-023p-1-7):
//   • `out/main/index.js`     — ESM (matches package `"type": "module"`).
//                              Electron supports ESM main since v28, so
//                              the 44.x pin carries it.
//                              In SMOKE mode this bundle additionally
//                              includes the probe body (the
//                              `[SIDEKICKS_SMOKE_PROBE]` tag and the
//                              `webContents.executeJavaScript(...)` call;
//                              the `about:blank` load was RETIRED at
//                              Plan-023 T-023p-1B-2, the probe now running
//                              against the real bundle). In RELEASE
//                              mode both are physically absent —
//                              Vite's `define` substitutes the outer
//                              `__SIDEKICKS_SMOKE_BUILD__` flag with
//                              `false` and Rollup eliminates the branch
//                              as dead code. The Spec-023 §Security
//                              Hardening Baseline runtime invariants
//                              (sidekicks defined; require / process /
//                              global all undefined) hold identically in
//                              both modes — the smoke probe just adds
//                              the readout machinery on top of the same
//                              trust-boundary surface, and the document it
//                              reads is the same one a release build loads.
//   • `out/preload/index.cjs` — CommonJS (sandboxed preload constraint).
//                              The explicit `.cjs` extension overrides the
//                              package `"type": "module"` so Node loads the
//                              file as CJS. Verified empirically: an ESM
//                              preload fails to register with `"SyntaxError:
//                              Cannot use import statement outside a module"`
//                              on Electron 41.6.1, unchanged on 44.x.
//   See `apps/desktop/electron.vite.config.ts` header for the decision log.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Package root — `apps/desktop/`. The test file lives at
// `apps/desktop/test/launch.smoke.test.ts`; `..` lands on the package root.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

// The `electron-vite build` output paths (per `apps/desktop/electron.vite.
// config.ts`'s per-target `outDir`). At Plan-023 Phase 1 T-023p-1-7 the
// build pipeline swapped from the original `tsc -b` posture to
// `electron-vite build` — the bundler bundles + handles the sandboxed-
// preload CJS constraint that `tsc -b`'s straight emit cannot satisfy
// (an ESM `import` in a `"type": "module"` package is rejected by
// Electron's sandboxed preload runtime, per the empirical evidence in
// the config header). `dist/` is now exclusively the `tsc -b` typecheck
// emit target (typecheck-only; not loaded at runtime).
const MAIN_ENTRY = path.join(PACKAGE_ROOT, "out/main/index.js");
const PRELOAD_ENTRY = path.join(PACKAGE_ROOT, "out/preload/index.cjs");

// Resolved Electron executable in the package's `node_modules/.bin`.
// `electron` is wired as a `devDependency` of `@ai-sidekicks/desktop`
// (apps/desktop/package.json line 26); pnpm's workspace install plants
// the launcher script at `node_modules/.bin/electron` per the package's
// `bin` entry. Resolving by absolute path (instead of PATH lookup)
// makes the test independent of the caller's `$PATH` configuration.
const ELECTRON_BIN = path.join(PACKAGE_ROOT, "node_modules/.bin/electron");

// Tagged-stdout marker emitted by the main-process smoke branch
// (`apps/desktop/src/main/index.ts` constant `SMOKE_PROBE_TAG`). The
// matching string here MUST stay in sync; if it drifts, the line
// scanner below silently times out instead of producing a clear
// diagnostic. The marker is deliberately uppercase + bracketed so it
// can't collide with normal Electron / Chromium log output.
const SMOKE_PROBE_TAG = "[SIDEKICKS_SMOKE_PROBE]";

// Spec-023 acceptance: window appears within 5 seconds. We allow a
// modest buffer above that on the SPAWN side so we can distinguish a
// slow-but-passing boot (which is still a pass per the AC: the inner
// `windowMs` measurement is the load-bearing one) from a fully-stuck
// Electron process (which we want to kill rather than hang the suite).
const WINDOW_BUDGET_MS = 5_000;
const SPAWN_TIMEOUT_MS = 15_000;

// Grace period between the SIGTERM issued at the spawn deadline and the
// SIGKILL backstop. `node_modules/.bin/electron` is a Node shim that spawns
// the real binary with `stdio: "inherit"` and forwards only the catchable
// signals; SIGKILLing the shim outright orphans an Electron process that
// still holds the inherited stdout write end, which delays this test's
// `close` event past the vitest deadline. SIGTERM lets the shim forward and
// the browser process exit; SIGKILL only if it does not.
const TERMINATION_GRACE_MS = 2_000;

interface SmokeProbe {
  readonly ok: boolean;
  readonly windowMs: number;
  readonly probe: {
    readonly sidekicks: string;
    readonly require: string;
    readonly process: string;
    readonly global: string;
    // Plan-023 Phase 1B (T-023p-1B-2) — the origin readings. These exist only
    // because the probe now runs against the REAL bundle served over the
    // privileged scheme; on the retired `about:blank` document every one of
    // them would have read the opaque origin instead.
    readonly protocol: string;
    readonly host: string;
    readonly indexedDB: string;
    readonly localStorageRoundTrip: boolean;
    readonly rootChildren: number;
  };
  // Read by the MAIN process, not the renderer: `net.fetch` against the served
  // `index.html`, so the header is observed on the wire the window loads from.
  readonly contentSecurityPolicy: string | null;
}

interface SpawnResult {
  readonly probe: SmokeProbe | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
}

function needsXvfb(): boolean {
  // GitHub Actions `ubuntu-latest` is headless: no `$DISPLAY`. The runner
  // ships `xvfb-run` preinstalled, so we wrap the Electron spawn with a
  // virtual framebuffer rather than skipping the test. macOS / Windows /
  // local Linux developers (with a display server) take the direct-spawn
  // path. The `!process.env["DISPLAY"]` guard means a Linux contributor
  // with X11 / Wayland running gets the same direct path as macOS — they
  // don't need `xvfb-run` installed locally.
  return process.platform === "linux" && !process.env["DISPLAY"];
}

// Signals the ENTIRE spawned tree, not just the wrapper. The direct child is a
// shim on both spawn paths — the `node_modules/.bin/electron` Node launcher, or
// `xvfb-run` on headless Linux — and a signal delivered to the shim alone
// reaches the real browser process only if the shim survives to forward it.
// SIGKILL cannot be forwarded by definition, so killing the shim outright
// orphans the browser holding the inherited stdout write end: `close` never
// fires, the "bounded" spawn promise never settles, and the orphan keeps its
// profile lock. The spawn below is `detached` on POSIX, so the child leads its
// own process group and a negative-pid signal reaches every process in the
// tree at once; on Windows, where no process group exists, `taskkill /t`
// walks the descendant tree to the same effect. The direct-child fallback
// covers the group already being reaped (ESRCH) and a child that never
// received a pid.
function terminateElectronTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    // No POSIX process group exists here, and `child.kill` reaches only the
    // launcher: Windows "signals" are TerminateProcess calls, which are never
    // forwarded, so the browser would survive holding the inherited stdout
    // write end — the same orphan the group delivery prevents on POSIX.
    // `taskkill /t` walks the launcher's descendant tree instead: without
    // `/f` it posts WM_CLOSE to each windowed process (the graceful analog —
    // exactly the tree members that matter here have windows), with `/f` it
    // terminates every node outright (the SIGKILL analog). A tree already
    // gone makes taskkill exit non-zero, which is the same no-op the POSIX
    // arm absorbs via ESRCH.
    if (child.pid !== undefined) {
      const forcedArguments = signal === "SIGKILL" ? ["/f"] : [];
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", ...forcedArguments], {
        stdio: "ignore",
      });
      return;
    }
    child.kill(signal);
    return;
  }
  const groupLeaderPid = child.pid;
  if (groupLeaderPid !== undefined) {
    try {
      process.kill(-groupLeaderPid, signal);
      return;
    } catch {
      // Group gone or unsupported — fall through so escalation still lands on
      // whatever the direct child handle can reach.
    }
  }
  child.kill(signal);
}

function spawnElectron(): Promise<SpawnResult> {
  const startedAt = Date.now();

  // Per-spawn Chromium profile — the deterministic fix for this test's
  // historical flake, and the reason it needs no retry wrapper.
  //
  // Without `--user-data-dir` the spawn inherits Electron's DEFAULT profile
  // (`~/Library/Application Support/Electron` on macOS,
  // `$XDG_CONFIG_HOME/Electron` on Linux). That directory's `SingletonLock`
  // is shared with every other default-profile Electron on the machine: a
  // second checkout running this same suite, an unrelated Electron app a
  // developer has open, or an Electron orphaned by an earlier terminated
  // run. Whichever process loses the lock takes the
  // `app.requestSingleInstanceLock()` false branch in
  // `apps/desktop/src/main/index.ts`, calls `app.quit()` before a window is
  // ever created, and exits 0 having printed nothing — from this end
  // indistinguishable from a substrate that failed to boot.
  //
  // Reproduced by spawning two default-profile probes concurrently: the
  // loser logs `process_singleton_posix.cc: Failed to create
  // .../SingletonLock: File exists (17)` on stderr, and sometimes prints
  // nothing at all (the lock owner is notified over the singleton socket
  // and the loser exits silently). A private profile makes the lock
  // per-spawn, so the collision is unreachable rather than merely unlikely.
  // The sibling `lifecycle.gc.test.ts` isolates its profile for exactly
  // this reason.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sidekicks-smoke-test-"));

  // `xvfb-run -a` auto-picks an unused display number; without `-a` it
  // defaults to `:99` and fails if another xvfb-run instance has claimed
  // it (a real concern on CI runners that may run multiple jobs in
  // parallel against the same image cache).
  //
  // Chromium switches MUST precede the entry-script path so Electron routes
  // them to the browser process rather than passing them through to the app.
  const electronArgs = [`--user-data-dir=${userDataDir}`, MAIN_ENTRY];
  const cmd = needsXvfb() ? "xvfb-run" : ELECTRON_BIN;
  const args = needsXvfb() ? ["-a", ELECTRON_BIN, ...electronArgs] : electronArgs;

  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        // Activates the main-process smoke-mode branch declared in
        // `apps/desktop/src/main/index.ts`. The branch is conditional on
        // exactly the string "1" so it is a deliberate opt-in. The
        // outer branch condition is the compile-time-static
        // `__SIDEKICKS_SMOKE_BUILD__` flag (Vite `define`); in a release
        // bundle that flag is substituted with `false` and the entire
        // branch — including this env-var lookup — is eliminated by
        // Rollup's dead-code pass. So this env var has NO effect on a
        // release binary: the code that reads it is physically absent
        // (`grep -c SIDEKICKS_SMOKE_PROBE out/main/index.js` returns 0
        // after `pnpm build`). In a smoke bundle, the runtime env-var
        // check remains as defense-in-depth so the probe never
        // auto-runs without explicit opt-in per invocation.
        SIDEKICKS_SMOKE_PROBE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: lead a NEW process group so the timeout escalation can signal
      // the whole tree (shim + browser + renderer/GPU children) at once — see
      // `terminateElectronTree`. Never detached on Windows, where the flag
      // means a detached console rather than a process group.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let probe: SmokeProbe | null = null;
    // Line-buffer accumulator for the stdout scanner. The Node `data` event
    // delivers arbitrary chunks; a logical line (the tagged probe payload)
    // can be split across two chunks if the chunk boundary falls inside
    // the line. We retain the unfinished trailing suffix between events
    // and only treat a substring as a "line" once we've seen its `\n`.
    // In practice the probe payload is ~150 bytes and Node stdout chunks
    // are 16-64 KB, so fragmentation is unlikely — but a silent timeout
    // (probe present in output, fragmented across chunks, never matched)
    // is a debugging nightmare we cheaply avoid by buffering.
    let pending = "";
    let escalationTimer: NodeJS.Timeout | null = null;

    const spawnDeadline = setTimeout(() => {
      // The spawn timeout (15 s) is a backstop — the in-app window
      // budget (5 s) is the load-bearing assertion. If we hit this,
      // Electron is stuck and we want a non-hanging test failure.
      //
      // SIGTERM before SIGKILL, both delivered to the process GROUP: the
      // graceful pass lets Electron shut its children down in order, and the
      // escalation is the backstop for a tree that ignores it. Group delivery
      // is what makes the backstop sound — SIGKILL is unforwardable, so a
      // shim-only kill would orphan the browser process with the inherited
      // stdout write end open and `close` would never fire (the unbounded
      // hang this timer exists to prevent).
      terminateElectronTree(child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        terminateElectronTree(child, "SIGKILL");
      }, TERMINATION_GRACE_MS);
    }, SPAWN_TIMEOUT_MS);

    // Single settle path so both timers and the temporary profile are
    // disposed exactly once whichever terminal event fires first.
    // `rmSync` with `force: true` is idempotent, so a `close` arriving
    // after a spawn `error` cannot fail here.
    const settle = (result: SpawnResult): void => {
      clearTimeout(spawnDeadline);
      if (escalationTimer !== null) {
        clearTimeout(escalationTimer);
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup. A leftover temp profile is harmless;
        // surfacing the cleanup error would mask the actual test result.
      }
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      // Accumulate into `pending`, slice off complete lines (split on
      // `\n`), retain the (possibly empty) suffix for the next chunk.
      // `lines.pop()` returns either the unterminated trailing piece
      // (if the chunk did NOT end on `\n`) or an empty string (if it
      // did) — both are correct values to carry forward.
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      // Scan for the tagged probe line. The tag is unique enough that a
      // line-anchored substring match is sufficient; we don't need a
      // full JSON-line parser. We parse the suffix after the tag as JSON.
      for (const line of lines) {
        const ix = line.indexOf(SMOKE_PROBE_TAG);
        if (ix < 0) continue;
        const payload = line.slice(ix + SMOKE_PROBE_TAG.length).trim();
        if (!payload.startsWith("{")) continue;
        try {
          probe = JSON.parse(payload) as SmokeProbe;
        } catch {
          // Tagged but malformed — keep scanning subsequent lines. This
          // shouldn't happen in practice (main process emits one well-
          // formed line) but the defensive parse keeps a partial chunk
          // from masking a later valid one.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // Silent-failure-shape mitigation. Node's `child_process.spawn` emits an
    // `error` event on the child (not as a throw) when the binary itself
    // cannot be launched — most commonly `ENOENT` if `xvfb-run` is missing
    // on PATH. The `existsSync` block in the first `it(...)` only verifies
    // `ELECTRON_BIN`, not `xvfb-run` (which is resolved by PATH at spawn
    // time, not a fixed absolute path). Without this listener, a Linux dev
    // machine without a display server AND without `xvfb-run` installed
    // would hit an unhandled `error` event → vitest would crash with a bare
    // stack trace, bypassing the diagnostic-rich failure path below. Route
    // the error through the same `settle()` so the "probe is null" branch
    // in the test produces a useful diagnostic (binary name + reason).
    child.on("error", (err: Error) => {
      settle({
        probe: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        exitCode: null,
        signal: null,
        elapsedMs: Date.now() - startedAt,
      });
    });

    child.on("close", (exitCode, signal) => {
      settle({
        probe,
        stdout,
        stderr,
        exitCode,
        signal,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

// Names the readiness signal that never arrived when no probe line was
// parsed. Every one of these outcomes reaches the test as the same
// "probe is null" shape, so without this classification the reader has to
// re-derive the cause from raw child output on every failure.
function diagnoseMissingProbe(result: SpawnResult): string {
  if (/SingletonLock|SingletonCookie|process_singleton/i.test(result.stderr)) {
    return (
      "Electron never took its single-instance lock, so the main process quit " +
      "before creating a window. The per-spawn `--user-data-dir` above is " +
      "supposed to make that unreachable — a hit here means the profile is " +
      "being shared again."
    );
  }
  if (result.stderr.includes("failed to load sidekicks-renderer://")) {
    return (
      "the window was created but the bundle never loaded over the renderer " +
      "scheme, so the preload never executed and `did-finish-load` never " +
      "fired. Either the scheme was not registered before ready or the " +
      "handler refused `index.html` — the handler answers an escape with an " +
      "empty-bodied 403 and a miss with an empty-bodied 404, so the renderer " +
      "side reports only the failure, never the reason."
    );
  }
  if (result.stderr.includes(`${SMOKE_PROBE_TAG} executeJavaScript failed`)) {
    return "the renderer document loaded but the probe expression never evaluated in it.";
  }
  if (result.stderr.includes(`${SMOKE_PROBE_TAG} index fetch failed`)) {
    return (
      "the renderer loaded, but the main process could not fetch " +
      "`sidekicks-renderer://app/index.html` back through its own handler to " +
      "read the CSP header."
    );
  }
  if (result.signal !== null) {
    return (
      `the process was still running at the ${String(SPAWN_TIMEOUT_MS)}ms deadline and was ` +
      `terminated (${result.signal}) — \`did-finish-load\` never fired.`
    );
  }
  if (result.exitCode === 1) {
    return "`app.whenReady()` rejected — the main process failed during startup.";
  }
  if (result.exitCode === 0 && result.stdout.trim() === "") {
    // The silent arm of a lost single-instance lock: Chromium's process
    // singleton notifies the existing owner over its socket and exits 0
    // without logging anything, so the stderr match above cannot see it.
    return (
      "the main process exited 0 having printed nothing at all — it never " +
      "reached the probe branch. This is the silent arm of the same lock loss " +
      "the branch above names: the process singleton notifies the existing " +
      "owner over its socket and exits without logging, so the profile is " +
      "being shared with another Electron."
    );
  }
  return "the process exited without emitting the probe line and without a recognised failure marker.";
}

// Doc references for this suite (Plan-023 Phase 1 T-023p-1-7,
// Spec-023 §Security Hardening Baseline / §Acceptance Criteria) are in the
// file header and the per-assertion comments below — never in the emitted
// test titles.
describe("desktop shell substrate boot", () => {
  it("verifies built bundle exists before spawning Electron", () => {
    // Fail-fast diagnostic. If the test runs without the smoke bundle
    // present, the Electron spawn would fail with a cryptic "cannot
    // find module" — this assertion produces a clear message pointing
    // to the smoke-build step instead. Diagnostics suggest `pnpm test`
    // (which orchestrates `build:smoke` before vitest) rather than
    // `pnpm build` (which produces a release bundle whose probe branch
    // is tree-shaken — this test cannot run against it).
    expect(
      existsSync(MAIN_ENTRY),
      `Main entry missing at ${MAIN_ENTRY}. Run \`pnpm --filter @ai-sidekicks/desktop test\` (which rebuilds the smoke bundle).`,
    ).toBe(true);
    expect(
      existsSync(PRELOAD_ENTRY),
      `Preload entry missing at ${PRELOAD_ENTRY}. Run \`pnpm --filter @ai-sidekicks/desktop test\` (which rebuilds the smoke bundle).`,
    ).toBe(true);
    expect(
      existsSync(ELECTRON_BIN),
      `Electron launcher missing at ${ELECTRON_BIN}. Run \`pnpm install\` first.`,
    ).toBe(true);
  });

  // Asserts the Spec-023 §Security Hardening Baseline runtime invariants:
  // the preload bridge registered, and none of the three Node-API-leak
  // globals named by `Spec-023 §Acceptance Criteria` reached the renderer.
  it(
    "renderer exposes the preload bridge and leaks no Node globals",
    async () => {
      const result = await spawnElectron();

      // Surface stderr + stdout if the probe line never arrived, so a
      // failure here is debuggable from CI logs without re-running.
      if (!result.probe) {
        throw new Error(
          `Desktop shell never became ready: ${diagnoseMissingProbe(result)}\n` +
            `No \`${SMOKE_PROBE_TAG}\` line arrived within ${String(SPAWN_TIMEOUT_MS)}ms.\n` +
            `Exit code: ${String(result.exitCode)}, signal: ${String(result.signal)}, elapsed: ${String(result.elapsedMs)}ms.\n` +
            `--- stdout ---\n${result.stdout}\n` +
            `--- stderr ---\n${result.stderr}\n`,
        );
      }

      const probe = result.probe;

      // Invariant 1: main window appears within 5 seconds.
      // The `windowMs` measurement is from `app.whenReady()` to
      // `webContents.did-finish-load` on the REAL renderer bundle served over
      // `sidekicks-renderer://` (Plan-023 Phase 1B) — i.e. the moment the
      // renderer is up, the preload has executed, and the served document has
      // finished loading. The retired `about:blank` arm measured only that a
      // window existed, so this budget now covers the handler and the bundle
      // as well.
      expect(probe.ok).toBe(true);
      expect(probe.windowMs).toBeLessThanOrEqual(WINDOW_BUDGET_MS);

      // Invariant 2: `window.sidekicks` is defined on the renderer.
      // Per the preload (`apps/desktop/src/preload/index.ts` line 32),
      // `contextBridge.exposeInMainWorld("sidekicks", createTier1Bridge())`
      // runs on every preload load. If `contextIsolation`, `sandbox`, or
      // the preload path is misconfigured, this would be `"undefined"`.
      expect(probe.probe.sidekicks).toBe("object");

      // Invariant 3: `window.require` is `undefined` — i.e., no Node API
      // leak into the renderer. `Spec-023 §Acceptance Criteria`:
      // "Renderer attempts to access `require`, `process`, or `global`
      // return `undefined` — verified by runtime assertion in a sandbox
      // test." If this drifts to `"function"`, `nodeIntegration: true`
      // has slipped past `assert-webprefs.ts`.
      expect(probe.probe.require).toBe("undefined");

      // Invariant 4: `window.process` is `undefined` — the second of the
      // three Node-API-leak globals named by `Spec-023 §Acceptance Criteria`
      // (require / process / global).
      expect(probe.probe.process).toBe("undefined");

      // Invariant 5: `window.global` is `undefined` — the third Node-API-
      // leak global named by `Spec-023 §Acceptance Criteria`. Tier 1
      // covers the full set of three at this single smoke layer; the Tier 8
      // Playwright `_electron` E2E suite repeats the assertion across the
      // packaged-binary surfaces (signed installer, asar bundle, autoupdate
      // applied snapshot) but the Tier 1 substrate is the load-bearing
      // single-source-of-truth that the runtime invariant holds.
      expect(probe.probe.global).toBe("undefined");

      // Invariant 6 (Plan-023 Phase 1B, I-023-11): the document came from the
      // privileged scheme at the `app` host. This is the assertion that
      // distinguishes "a window exists" from "the bundle is served" — the
      // whole reason the `about:blank` arm was retired.
      expect(probe.probe.protocol).toBe("sidekicks-renderer:");
      expect(probe.probe.host).toBe("app");

      // Invariant 7 (I-023-11): the origin carries storage. A scheme
      // registered WITHOUT `standard: true` still loads documents — it just
      // has an opaque origin, so `indexedDB` is absent and `localStorage`
      // throws. The console's persisted layouts, drafts, and pins
      // (`Spec-023 §Console Design (Meridian)` §Persistence) live here, so a
      // silent regression to a non-standard scheme would surface as data that
      // never survives a restart rather than as an error.
      expect(probe.probe.indexedDB).toBe("object");
      expect(probe.probe.localStorageRoundTrip).toBe(true);

      // Invariant 8: the React tree actually mounted inside the served
      // document. `did-finish-load` fires on the document, not on the app, so
      // without this a bundle whose entry chunk 404'd would still pass every
      // assertion above.
      expect(probe.probe.rootChildren).toBeGreaterThan(0);

      // Invariant 9: the CSP header rides the response. The header is the
      // policy's ONLY carrier — `index.html` deliberately ships no meta tag —
      // so nothing else in the suite would notice it silently disappearing.
      // Read from the main process through `net.fetch` against the handler's
      // own output, not from the renderer, because a renderer cannot read its
      // own response headers.
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
      // Nothing in the policy may admit remote script or a wildcard origin;
      // asserting the presence of each directive above would not catch a
      // widened one appended beside it.
      expect(contentSecurityPolicy).not.toContain("unsafe-eval");
      expect(contentSecurityPolicy).not.toContain("*");
      expect(contentSecurityPolicy).not.toContain("http://");

      // Process should have exited cleanly via `app.exit(0)` from the
      // probe branch. Signal-killed (timeout) or non-zero exit means
      // the substrate did not boot as expected.
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
    },
    SPAWN_TIMEOUT_MS + 5_000, // Vitest timeout = spawn budget + slack.
  );

  // The retirement, asserted rather than assumed (Plan-023 T-023p-1B-2).
  //
  // The smoke bundle is the one build where the probe body SURVIVES — a
  // release bundle tree-shakes the whole branch, so grepping it for
  // `about:blank` would pass no matter what the source said. Checking the
  // smoke bundle is therefore the only form of this assertion with any force:
  // if anyone re-introduces a blank-document load behind the probe gate, the
  // suite's other assertions would go on passing (a blank document has a
  // `#root`-less DOM, so they would actually FAIL — but for a reason nobody
  // would read as "the retirement was reverted"). This says it directly.
  it("ships no blank-document load in the built smoke bundle", () => {
    expect(
      existsSync(MAIN_ENTRY),
      `Main entry missing at ${MAIN_ENTRY}. Run \`pnpm --filter @ai-sidekicks/desktop test\` (which rebuilds the smoke bundle).`,
    ).toBe(true);

    const builtMainBundle = readFileSync(MAIN_ENTRY, "utf8");

    expect(builtMainBundle).not.toContain("about:blank");
    // Positive control: the probe body IS present in this bundle, so the
    // absence above is a real absence and not a mis-pointed path or a release
    // bundle that tree-shook everything.
    expect(builtMainBundle).toContain(SMOKE_PROBE_TAG);
    expect(builtMainBundle).toContain("sidekicks-renderer://app/index.html");
  });
});
