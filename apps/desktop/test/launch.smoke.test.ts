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
// Linux display handling:
//   GitHub Actions `ubuntu-latest` has no display server. CI stands up ONE
//   Xvfb for the whole job and exports `$DISPLAY` only after `xdpyinfo`
//   confirms the server is answering (see `.github/workflows/ci.yml`), so this
//   harness spawns Electron directly there and verifies the same readiness
//   condition itself before spawning. A Linux contributor with no `$DISPLAY`
//   still gets the original `xvfb-run -a` fallback; macOS and Windows spawn
//   directly as before.
//
// Boot determinism (why the readiness gate and the diagnostic dump exist):
//   This suite intermittently failed with a bare "did-finish-load never fired"
//   at the 15 s deadline and an EMPTY stderr — nothing to diagnose from. Two
//   defects produced that:
//
//     (a) `apps/desktop/test/` holds two files that each spawn a full
//         Electron/Chromium tree, and vitest's default `fileParallelism` ran
//         them concurrently on a 4-vCPU runner while `lifecycle.gc.test.ts`
//         drove 80 forced full GCs. Fixed at the scheduler in
//         `apps/desktop/vitest.config.ts`, not by widening this budget.
//     (b) the harness captured nothing about the environment, and its
//         stderr-keyed diagnosis arms were unreachable under `xvfb-run`'s
//         stderr-into-stdout merge. Fixed by `SpawnResult.combinedOutput`,
//         the readiness breadcrumbs, and `renderDiagnosticDump`.
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
//                              Electron 41 supports ESM main since v28.
//                              In SMOKE mode this bundle additionally
//                              includes the probe body (the
//                              `[SIDEKICKS_SMOKE_PROBE]` tag, the
//                              `webContents.executeJavaScript(...)` call,
//                              and the `about:blank` load). In RELEASE
//                              mode all three are physically absent —
//                              Vite's `define` substitutes the outer
//                              `__SIDEKICKS_SMOKE_BUILD__` flag with
//                              `false` and Rollup eliminates the branch
//                              as dead code. The Spec-023 §Security
//                              Hardening Baseline runtime invariants
//                              (sidekicks defined; require / process /
//                              global all undefined) hold identically in
//                              both modes — the smoke probe just adds
//                              the readout machinery on top of the same
//                              trust-boundary surface.
//   • `out/preload/index.cjs` — CommonJS (sandboxed preload constraint).
//                              The explicit `.cjs` extension overrides the
//                              package `"type": "module"` so Node loads the
//                              file as CJS. Verified empirically: an ESM
//                              preload fails to register with `"SyntaxError:
//                              Cannot use import statement outside a module"`
//                              on Electron 41.6.1.
//   See `apps/desktop/electron.vite.config.ts` header for the decision log.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
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

// Tagged-stderr marker for the corroborating readiness breadcrumbs
// (`apps/desktop/src/main/index.ts` constant `READINESS_BREADCRUMB_TAG`).
// `did-finish-load` remains the ONLY asserted signal — `dom-ready` and
// `ready-to-show` are recorded so a timeout says WHERE the boot stopped rather
// than only that it did. Kept off stdout so the probe-line scanner above sees
// exactly one tagged line.
const READINESS_BREADCRUMB_TAG = "[SIDEKICKS_SMOKE_READY]";

// Spec-023 acceptance: window appears within 5 seconds. We allow a
// modest buffer above that on the SPAWN side so we can distinguish a
// slow-but-passing boot (which is still a pass per the AC: the inner
// `windowMs` measurement is the load-bearing one) from a fully-stuck
// Electron process (which we want to kill rather than hang the suite).
const WINDOW_BUDGET_MS = 5_000;

// Spawn-side backstop. Derived from measurement, not from guesswork:
//
//   Unloaded spawn -> probe line, 5 consecutive runs (macOS 14, M1 Pro,
//   warm bundle): 462 / 483 / 510 / 490 / 505 ms, with the in-app
//   `windowMs` (whenReady -> did-finish-load) at 121-131 ms.
//
// 15 s is ~30x the measured cost, so this budget is NOT the reason the
// suite flaked — it is the backstop that reports the stall. The flake's
// root cause was contention between this file and `lifecycle.gc.test.ts`
// (see `apps/desktop/vitest.config.ts`'s `main` project `fileParallelism`
// comment); that is fixed at the scheduler, and the budget is deliberately
// left where it is rather than raised to paper over a stall.
const SPAWN_TIMEOUT_MS = 15_000;

// How long to wait for the X display named by `$DISPLAY` to start answering
// before we give up and refuse to spawn. On a hosted runner the display is
// stood up by the CI job (see `.github/workflows/ci.yml`, the Xvfb step),
// which already gates on readiness — this is the harness-side restatement so
// a display that is configured but dead produces an immediate, named refusal
// instead of a 15 s silence.
const DISPLAY_READY_TIMEOUT_MS = 10_000;
const DISPLAY_POLL_INTERVAL_MS = 250;

// Budget used when the test-only display override below is in force. The
// negative control asserts the SHAPE of the refusal (a named diagnostic dump
// rather than a bare timeout), not how long the harness is willing to wait, so
// it does not need to sit through the real budget.
const FORCED_DISPLAY_READY_TIMEOUT_MS = 1_000;

// Test-only switch. Set to an X display that nothing serves, it makes the
// readiness path fail deterministically on every platform so the negative
// control can assert that the harness emits its diagnostic dump rather than a
// bare timeout. Consulted ONLY by this file; the shipped app never reads it.
const FORCED_DISPLAY_ENV = "SIDEKICKS_SMOKE_FORCE_DISPLAY";

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
  };
}

interface SpawnResult {
  readonly probe: SmokeProbe | null;
  readonly stdout: string;
  readonly stderr: string;
  // stdout and stderr concatenated in arrival order.
  //
  // Load-bearing, not a convenience: on the headless-Linux path the child is
  // wrapped by `xvfb-run`, whose Debian/Ubuntu implementation runs the command
  // as `DISPLAY=... XAUTHORITY=... "$@" 2>&1` — it MERGES the child's stderr
  // into stdout. Proof from the failing CI run (33571210321): the electron
  // launcher shim emits its "exited with signal" notice through
  // `console.error` (`node_modules/electron/cli.js` line 12, i.e. stderr) and
  // that line arrived in this harness's STDOUT capture while `--- stderr ---`
  // was empty. Every `result.stderr`-keyed arm of `diagnoseMissingProbe` was
  // therefore unreachable on exactly the platform CI runs. Diagnosis now keys
  // off this field so it works under either stream topology.
  readonly combinedOutput: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
  // Ordered readiness breadcrumbs parsed out of the child's output — the
  // corroborating `dom-ready` / `ready-to-show` signals the main process emits
  // beside the asserted `did-finish-load`, each with its offset from
  // `app.whenReady()`. Empty means the renderer never reached even the first
  // of them, which is a different failure from "loaded but never finished".
  readonly readinessBreadcrumbs: readonly string[];
  // Environment readings taken at spawn time and again at the deadline, so a
  // timeout is attributable from one read of the CI log.
  readonly diagnostics: readonly string[];
}

// Resolves the X display this spawn should use, honouring the test-only
// override that drives the negative control.
function resolvedDisplay(): string | undefined {
  return process.env[FORCED_DISPLAY_ENV] ?? process.env["DISPLAY"];
}

function needsXvfb(): boolean {
  // GitHub Actions `ubuntu-latest` is headless. CI now stands up ONE Xvfb for
  // the whole job and exports `$DISPLAY` (see `.github/workflows/ci.yml`), so
  // this returns false there and the spawn is direct.
  //
  // The `xvfb-run` fallback remains for a Linux contributor with no display
  // server, but it is deliberately no longer CI's path. `xvfb-run -a` picks a
  // display number with `find_free_servernum()`, a plain
  // `while [ -f /tmp/.X$i-lock ]` scan — a documented TOCTOU
  // (Debian #521075 / Launchpad #348052) that two concurrent invocations can
  // lose together. It self-heals through the script's retry loop, so it was
  // not this flake's root cause, but it costs a second X server and a second
  // shell per spawn and it merges the child's stderr into stdout (see
  // `SpawnResult.combinedOutput`). A job-level display removes all three.
  return process.platform === "linux" && !resolvedDisplay();
}

// Chromium switches applied on the headless-Linux path only.
//
// NONE of these weakens the renderer sandbox this test exists to assert.
// `.github/workflows/ci.yml` forbids `--no-sandbox` for exactly that reason:
// it disables the renderer's Linux namespace sandbox, and the three-globals
// assertion below (`require` / `process` / `global` all `undefined`) is a
// direct consequence of `webPreferences.sandbox: true` holding. The switches
// here select a COMPOSITING BACKEND and a SHARED-MEMORY LOCATION; they change
// no process-sandbox policy and no `webPreferences` value:
//
//   --disable-gpu ............. skip GPU-process hardware init and composite
//                               in software. The GPU process is a separate
//                               process type from the renderer; its presence
//                               or absence does not alter renderer sandboxing.
//                               On a hosted runner there is no GPU to use, so
//                               this removes an init path that can only stall.
//   --disable-dev-shm-usage ... write shared-memory files under /tmp instead
//                               of a possibly-small /dev/shm. A location
//                               choice, not a privilege change.
//   --password-store=basic .... use the in-process store rather than probing
//                               gnome-keyring / kwallet over D-Bus. Removes a
//                               session-bus round trip on a box with no
//                               session bus.
//
// The invariant is also enforced empirically rather than only by argument: if
// any switch here did weaken the sandbox, the three-globals assertions would
// fail rather than silently pass.
const LINUX_HEADLESS_CHROMIUM_SWITCHES: readonly string[] = [
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--password-store=basic",
];

// Resolved once: probing for the tool on every poll would spawn a process per
// iteration to answer a question whose answer cannot change mid-run.
const xdpyinfoMissing =
  spawnSync("xdpyinfo", ["-version"], { stdio: "ignore" }).error !== undefined;

// Local `:N` displays expose a unix socket at a well-known path. A remote or
// path-style `$DISPLAY` (an XQuartz launchd socket, `host:0` over TCP) does
// not, which is why the readiness gate declines rather than guesses for those.
function localDisplaySocketPath(display: string): string | null {
  const localDisplay = /^:(\d+)(\.\d+)?$/.exec(display);
  return localDisplay === null ? null : `/tmp/.X11-unix/X${localDisplay[1]}`;
}

// Does the named X display actually answer?
//
// Two probes, strongest first:
//
//   1. `xdpyinfo` — a real client handshake, so a socket that exists but is not
//      serving fails it exactly as Electron would.
//   2. the display's unix socket — used when `xdpyinfo` is absent, which is the
//      normal case on CI: the ubuntu-24.04 runner image ships `xvfb` but NOT
//      `x11-utils`. Weaker (a crashed server can leave a stale socket behind),
//      and named as weaker rather than presented as equivalent. It is still
//      decisive for the case that matters here — a `$DISPLAY` pointing at a
//      server that was never started.
//
// A display we cannot probe either way reports ready, so the gate never refuses
// a spawn it has no evidence against.
function displayAnswers(display: string): boolean {
  if (!xdpyinfoMissing) {
    const probe = spawnSync("xdpyinfo", ["-display", display], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return probe.error === undefined && probe.status === 0;
  }
  const socketPath = localDisplaySocketPath(display);
  return socketPath === null ? true : existsSync(socketPath);
}

// Blocks until the display answers or the budget expires. Returns null when
// ready, or a human-readable reason when not.
function awaitDisplayReady(display: string): string | null {
  // The negative control's override only shortens the budget — it does not make
  // the gate behave differently. `displayAnswers` is decisive on its own for a
  // local `:N` display on every platform, with or without `xdpyinfo`, so the
  // control drives exactly the production path.
  const budgetMs =
    process.env[FORCED_DISPLAY_ENV] !== undefined
      ? FORCED_DISPLAY_READY_TIMEOUT_MS
      : DISPLAY_READY_TIMEOUT_MS;
  const probeDescription = xdpyinfoMissing
    ? `no unix socket at ${localDisplaySocketPath(display) ?? "<unprobeable display>"}`
    : `\`xdpyinfo -display ${display}\` kept failing`;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (displayAnswers(display)) return null;
    if (Date.now() >= deadline) {
      return (
        `X display ${display} did not answer within ${String(budgetMs)}ms ` +
        `(${probeDescription}). Electron cannot open a window without it, so ` +
        `the spawn was refused rather than left to time out.`
      );
    }
    // Deliberately synchronous: this runs before the child exists, so there is
    // nothing to service on the event loop and a busy-free sleep keeps the
    // readiness gate a straight line.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DISPLAY_POLL_INTERVAL_MS);
  }
}

// Point-in-time environment reading, captured at spawn and again at the
// deadline.
//
// `probeExternals` gates the two subprocess-backed readings. They are the
// expensive half and they are only worth paying for on the failure path, so the
// at-spawn capture takes the cheap readings only and leaves the boot budget
// untouched; the at-deadline capture takes everything, because by then the
// budget is already spent and the readings are the whole point.
function captureDiagnostics(
  label: string,
  child: ChildProcess | null,
  probeExternals: boolean,
): string[] {
  const readings = [
    `[${label}] platform=${process.platform} cpus=${String(availableParallelism())} ` +
      `loadavg=${loadavg()
        .map((value) => value.toFixed(2))
        .join("/")}`,
    `[${label}] DISPLAY=${resolvedDisplay() ?? "<unset>"} ` +
      `spawnPath=${needsXvfb() ? "xvfb-run -a" : "direct"}`,
  ];
  const display = resolvedDisplay();
  if (probeExternals && display !== undefined && process.platform !== "win32") {
    if (xdpyinfoMissing) {
      // No `x11-utils` on the ubuntu-24.04 runner image, so report the socket
      // reading actually used rather than a tool reading we cannot take.
      const socketPath = localDisplaySocketPath(display);
      readings.push(
        `[${label}] display socket ${socketPath ?? "<unprobeable display>"} ` +
          `present=${socketPath === null ? "<unknown>" : String(existsSync(socketPath))} ` +
          `(xdpyinfo unavailable)`,
      );
    } else {
      const probe = spawnSync("xdpyinfo", ["-display", display], {
        encoding: "utf8",
        timeout: 5_000,
      });
      const dimensions = /dimensions:\s+(\S+)/.exec(probe.stdout ?? "")?.[1];
      readings.push(
        `[${label}] xdpyinfo status=${String(probe.status)} ` +
          `dimensions=${dimensions ?? "<none>"}`,
      );
    }
  }
  if (probeExternals && child?.pid !== undefined && process.platform !== "win32") {
    // The spawn leads its own process group, so `-g <pid>` is exactly this
    // spawn's tree and nothing else on the runner.
    const processTree = spawnSync(
      "ps",
      ["-o", "pid,ppid,stat,etime,comm", "-g", String(child.pid)],
      {
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    readings.push(
      `[${label}] process tree (pgid=${String(child.pid)}):\n${processTree.stdout ?? "<unavailable>"}`,
    );
  }
  return readings;
}

// Renders everything the harness learned about a spawn that produced no probe
// line. The point is that the NEXT failure is attributable from one read of
// the CI log rather than from a re-run.
function renderDiagnosticDump(result: SpawnResult): string {
  const breadcrumbs =
    result.readinessBreadcrumbs.length > 0
      ? result.readinessBreadcrumbs.join("\n")
      : "<none — the renderer never reached dom-ready, ready-to-show, or did-finish-load>";
  return (
    `--- readiness events observed ---\n${breadcrumbs}\n` +
    `--- environment ---\n${result.diagnostics.join("\n")}\n` +
    `--- stdout ---\n${result.stdout}\n` +
    `--- stderr ---\n${result.stderr}\n`
  );
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

  // Readiness gate. A display that is named but not serving is the one boot
  // precondition this harness can check cheaply and BEFORE spawning, so it is
  // checked here rather than discovered as a 15 s silence. On CI the job-level
  // Xvfb step has already gated on the same condition; this is the harness-side
  // restatement, and it is what the negative control drives.
  const display = resolvedDisplay();
  if (display !== undefined && !needsXvfb()) {
    const displayFailure = awaitDisplayReady(display);
    if (displayFailure !== null) {
      const refusal: SpawnResult = {
        probe: null,
        stdout: "",
        stderr: displayFailure,
        combinedOutput: displayFailure,
        exitCode: null,
        signal: null,
        elapsedMs: Date.now() - startedAt,
        readinessBreadcrumbs: [],
        diagnostics: captureDiagnostics("refused-before-spawn", null, false),
      };
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Best-effort, exactly as in `settle()`: a leftover temp profile is
        // harmless, and surfacing a cleanup error here would mask the refusal
        // this path exists to report.
      }
      return Promise.resolve(refusal);
    }
  }

  // `xvfb-run -a` auto-picks an unused display number; without `-a` it
  // defaults to `:99` and fails if another xvfb-run instance has claimed
  // it (a real concern on CI runners that may run multiple jobs in
  // parallel against the same image cache). This is now the local-developer
  // fallback only — CI exports `$DISPLAY` and takes the direct path.
  //
  // Chromium switches MUST precede the entry-script path so Electron routes
  // them to the browser process rather than passing them through to the app.
  const electronArgs = [
    ...(process.platform === "linux" ? LINUX_HEADLESS_CHROMIUM_SWITCHES : []),
    `--user-data-dir=${userDataDir}`,
    MAIN_ENTRY,
  ];
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
        // Emit the corroborating readiness breadcrumbs (`dom-ready`,
        // `ready-to-show`) beside the asserted `did-finish-load`. Opt-in per
        // invocation for the same reason the probe itself is: the main process
        // must never take a test-only code path it was not explicitly asked to.
        SIDEKICKS_SMOKE_TRACE_READINESS: "1",
        // Give Chromium a session-bus address that fails FAST rather than
        // leaving it unset. With `DBUS_SESSION_BUS_ADDRESS` unset, libdbus
        // attempts an X11/autolaunch fallback to find a bus; on a hosted runner
        // no bus exists, and the probe is a boot-path round trip that can only
        // cost time. `disabled:` is unparseable as an address, so the lookup
        // fails immediately instead of autolaunching. Paired with
        // `--password-store=basic` above, which removes the secret-service
        // consumer that would want the bus in the first place.
        ...(process.platform === "linux"
          ? { DBUS_SESSION_BUS_ADDRESS: "disabled:", NO_AT_BRIDGE: "1" }
          : {}),
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
    let combinedOutput = "";
    let probe: SmokeProbe | null = null;
    const readinessBreadcrumbs: string[] = [];
    const diagnostics: string[] = captureDiagnostics("at-spawn", child, false);
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
      //
      // Capture the environment BEFORE signalling: once SIGTERM lands the
      // process tree is gone and `ps` has nothing left to report, which is
      // precisely the reading that would have named this flake on its first
      // occurrence instead of its fourth.
      diagnostics.push(...captureDiagnostics("at-deadline", child, true));
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

    // Breadcrumbs are emitted by the main process on STDERR, but the
    // `xvfb-run` fallback merges the child's stderr into stdout, so both
    // streams are scanned. Ordering within a stream is preserved; the offsets
    // the main process stamps on each line are what makes the sequence
    // readable regardless of interleaving.
    const scanReadiness = (text: string): void => {
      for (const line of text.split("\n")) {
        const marker = line.indexOf(READINESS_BREADCRUMB_TAG);
        if (marker < 0) continue;
        readinessBreadcrumbs.push(line.slice(marker + READINESS_BREADCRUMB_TAG.length).trim());
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      combinedOutput += text;
      scanReadiness(text);
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
      const text = chunk.toString("utf8");
      stderr += text;
      combinedOutput += text;
      scanReadiness(text);
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
        combinedOutput: combinedOutput + `\n[spawn error] ${err.message}`,
        exitCode: null,
        signal: null,
        elapsedMs: Date.now() - startedAt,
        readinessBreadcrumbs,
        diagnostics,
      });
    });

    child.on("close", (exitCode, signal) => {
      settle({
        probe,
        stdout,
        stderr,
        combinedOutput,
        exitCode,
        signal,
        elapsedMs: Date.now() - startedAt,
        readinessBreadcrumbs,
        diagnostics,
      });
    });
  });
}

// Names the readiness signal that never arrived when no probe line was
// parsed. Every one of these outcomes reaches the test as the same
// "probe is null" shape, so without this classification the reader has to
// re-derive the cause from raw child output on every failure.
//
// Every marker match below reads `result.combinedOutput`, never
// `result.stderr`. Under the `xvfb-run` fallback the child's stderr is merged
// into stdout by the wrapper, so a `result.stderr` predicate is unreachable on
// exactly the platform CI runs — the defect that left run 33571210321
// reporting an empty `--- stderr ---`. See `SpawnResult.combinedOutput`.
function diagnoseMissingProbe(result: SpawnResult): string {
  if (result.combinedOutput.includes("did not answer within")) {
    return (
      "the X display named by `$DISPLAY` was not serving, so the spawn was " +
      "refused before Electron was started. On CI the job-level Xvfb step " +
      "owns this display; locally, either export a working `$DISPLAY` or " +
      "unset it so the `xvfb-run` fallback takes over."
    );
  }
  if (/SingletonLock|SingletonCookie|process_singleton/i.test(result.combinedOutput)) {
    return (
      "Electron never took its single-instance lock, so the main process quit " +
      "before creating a window. The per-spawn `--user-data-dir` above is " +
      "supposed to make that unreachable — a hit here means the profile is " +
      "being shared again."
    );
  }
  if (result.combinedOutput.includes(`${SMOKE_PROBE_TAG} loadURL failed`)) {
    return (
      "the window was created but `about:blank` never loaded, so the preload " +
      "never executed and `did-finish-load` never fired."
    );
  }
  if (result.combinedOutput.includes(`${SMOKE_PROBE_TAG} executeJavaScript failed`)) {
    return "the renderer document loaded but the probe expression never evaluated in it.";
  }
  if (result.signal !== null) {
    // The breadcrumbs turn one timeout shape into three distinguishable ones:
    // nothing at all (the browser process never got the renderer up), a
    // `dom-ready` with no `did-finish-load` (the document parsed but a
    // subresource never settled), or neither with a `ready-to-show` (the
    // window surfaced against a document that never parsed).
    const reached =
      result.readinessBreadcrumbs.length > 0
        ? `Readiness reached: ${result.readinessBreadcrumbs.join(", ")}.`
        : "No readiness event fired at all — the renderer never reached `dom-ready`.";
    return (
      `the process was still running at the ${String(SPAWN_TIMEOUT_MS)}ms deadline and was ` +
      `terminated (${result.signal}) — \`did-finish-load\` never fired. ${reached}`
    );
  }
  if (result.exitCode === 1) {
    return "`app.whenReady()` rejected — the main process failed during startup.";
  }
  if (result.exitCode === 0 && result.combinedOutput.trim() === "") {
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

// The single renderer for "no probe line arrived". Both the assertion path and
// the negative control below go through this function, so the control proves
// what the real failure would print rather than a re-implementation of it.
function renderReadinessFailure(result: SpawnResult): string {
  return (
    `Desktop shell never became ready: ${diagnoseMissingProbe(result)}\n` +
    `No \`${SMOKE_PROBE_TAG}\` line arrived within ${String(SPAWN_TIMEOUT_MS)}ms.\n` +
    `Exit code: ${String(result.exitCode)}, signal: ${String(result.signal)}, elapsed: ${String(result.elapsedMs)}ms.\n` +
    renderDiagnosticDump(result)
  );
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

      // Surface the full diagnostic dump if the probe line never arrived, so a
      // failure here is attributable from one read of the CI log without a
      // re-run. The dump carries the readiness events that DID fire with their
      // offsets, the environment readings taken at spawn and at the deadline
      // (display liveness, CPU count, load average, and the process tree of
      // this spawn's own group), and both raw streams.
      if (!result.probe) {
        throw new Error(renderReadinessFailure(result));
      }

      const probe = result.probe;

      // Invariant 1: main window appears within 5 seconds.
      // The `windowMs` measurement is from `app.whenReady()` to
      // `webContents.did-finish-load` on the loaded `about:blank`
      // document — i.e., the moment the renderer is up and the preload
      // has executed.
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

      // Process should have exited cleanly via `app.exit(0)` from the
      // probe branch. Signal-killed (timeout) or non-zero exit means
      // the substrate did not boot as expected.
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(null);
    },
    SPAWN_TIMEOUT_MS + 5_000, // Vitest timeout = spawn budget + slack.
  );

  // Negative control for the readiness path.
  //
  // The diagnostics added here are only worth having if they actually fire, and
  // "the dump would have printed" is not something the passing path can show —
  // on a healthy boot none of this code runs. So this test breaks the readiness
  // precondition deterministically (a display number nothing serves) and
  // asserts the harness produces a NAMED refusal carrying the dump, rather than
  // the bare 15 s timeout that run 33571210321 produced.
  //
  // It drives the real `spawnElectron()` and the real `renderReadinessFailure()`
  // — not a hand-built `SpawnResult` — so a regression that silently stopped
  // collecting diagnostics would fail here.
  //
  // The positive control is the test above: same harness, same renderer, live
  // display, and it reaches a probe line. Without that pairing this assertion
  // could pass against a harness that refused every spawn.
  it(
    "refuses a dead display with a diagnostic dump rather than a bare timeout",
    async () => {
      const deadDisplay = ":987";
      process.env[FORCED_DISPLAY_ENV] = deadDisplay;
      let failureMessage: string;
      try {
        const result = await spawnElectron();
        expect(result.probe).toBeNull();
        failureMessage = renderReadinessFailure(result);
      } finally {
        delete process.env[FORCED_DISPLAY_ENV];
      }

      // Classified, not the catch-all arm — the reader is told which
      // precondition failed.
      expect(failureMessage).toContain("was not serving");
      expect(failureMessage).not.toContain("without a recognised failure marker");

      // The dump itself, with the offending display named in it.
      expect(failureMessage).toContain("--- readiness events observed ---");
      expect(failureMessage).toContain("--- environment ---");
      expect(failureMessage).toContain(deadDisplay);
      expect(failureMessage).toContain(`DISPLAY=${deadDisplay}`);

      // No readiness event can have fired, because the spawn was refused
      // before Electron existed — and the dump says exactly that instead of
      // leaving the section blank.
      expect(failureMessage).toContain("<none — the renderer never reached");
    },
    FORCED_DISPLAY_READY_TIMEOUT_MS + 15_000,
  );
});
