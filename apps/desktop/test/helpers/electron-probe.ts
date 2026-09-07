// The Electron spawn-and-probe harness — Plan-023 Phase 1B.
//
// Extracted from `../launch.smoke.test.ts`, which had grown to ~1,780 lines of
// which the assertions were the last quarter. The split is by ROLE and not by
// size: everything here is about GETTING a probe reading out of a real Electron
// process — resolving the binary, reserving a display, spawning, scanning the
// tagged lines, collecting diagnostics when nothing arrives, and killing the
// tree — and none of it decides whether a reading is acceptable. That decision
// is the suite's, and it stayed there.
//
// The harness asserts nothing, deliberately. A helper that could fail a test
// would be a second place a smoke failure can come from, and the diagnostics
// below exist precisely because a failure here has to be legible from OUTSIDE
// the process it describes. It reaches one test-framework symbol and only
// through `electron-child.ts`, which registers the settle-time kill on
// `onTestFinished` — a teardown registrar, not an assertion API, and the reason
// a stalled Electron cannot outlive the test that spawned it.
//
// It is not a mock and has no fixture mode: every function here drives the real
// binary. `../../src/main/probes/smoke-probe.ts` is the other half of the same
// contract — it emits the tagged lines this module parses — and the two share
// their marker strings by restating them, which the suite's own scanner cases
// keep honest.

import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UNOBTRUSIVE_WINDOWS_ENV } from "../../src/main/window-reveal.js";
import { cleanUpAfterChildAtSettleTime } from "./electron-child-cleanup.js";
import { spawnManagedElectronChild, TEST_TIMEOUT_SLACK_MS } from "./electron-child.js";
import { TERMINATION_GRACE_MS } from "./managed-electron-child.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Package root — `apps/desktop/`. This module lives at
// `apps/desktop/test/helpers/electron-probe.ts`; `../..` lands on the package
// root, which every path below is resolved against.
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

// The `electron-vite build` output paths (per `apps/desktop/electron.vite.
// config.ts`'s per-target `outDir`). At Plan-023 Phase 1 T-023p-1-7 the
// build pipeline swapped from the original `tsc -b` posture to
// `electron-vite build` — the bundler bundles + handles the sandboxed-
// preload CJS constraint that `tsc -b`'s straight emit cannot satisfy
// (an ESM `import` in a `"type": "module"` package is rejected by
// Electron's sandboxed preload runtime, per the empirical evidence in
// the config header). `dist/` is now exclusively the `tsc -b` typecheck
// emit target (typecheck-only; not loaded at runtime).
export const MAIN_ENTRY: string = path.join(PACKAGE_ROOT, "out/main/index.js");
export const PRELOAD_ENTRY: string = path.join(PACKAGE_ROOT, "out/preload/index.cjs");

// Resolved Electron executable in the package's `node_modules/.bin`.
// `electron` is wired as a `devDependency` of `@ai-sidekicks/desktop`
// (apps/desktop/package.json line 26); pnpm's workspace install plants
// the launcher script at `node_modules/.bin/electron` per the package's
// `bin` entry. Resolving by absolute path (instead of PATH lookup)
// makes the test independent of the caller's `$PATH` configuration.
export const ELECTRON_BIN: string = path.join(PACKAGE_ROOT, "node_modules/.bin/electron");

// Where the Electron BINARY lives, as distinct from the launcher shim above.
//
// Electron 44 publishes NO install script — 41.6.1 published
// `postinstall: node install.js`; 44.1.0's manifest has no `scripts` field at
// all — and moved binary acquisition into a lazy download on the first
// `require('electron')`. So `pnpm install` alone plants the shim and leaves no
// `dist/`, and the first spawn would pay a 120-160 MB download INSIDE this suite's
// spawn deadline: a `SPAWN_TIMEOUT_MS` timeout whose message says nothing about
// downloading. `apps/desktop/scripts/materialize-electron.ts` closes that as an
// install-time step (wired as this package's `postinstall`, and re-run by
// `test:smoke` and by CI), and the pre-spawn assertion below turns the residual
// case — a tree where that step was skipped — into a named refusal instead of a
// timeout.
//
// This is a PRESENCE probe, deliberately not a copy of the materializer's
// idempotence rule: that one additionally compares `dist/version` against the
// installed package version, because it decides whether to re-download. A
// stale-but-present binary still spawns without a download, which is the only
// property this suite needs.
export const ELECTRON_PACKAGE_ROOT: string = path.join(PACKAGE_ROOT, "node_modules/electron");

/** The materialized Electron executable, or `null` when it is not on disk. */
export function materializedElectronExecutable(): string | null {
  const pathFile = path.join(ELECTRON_PACKAGE_ROOT, "path.txt");
  if (!existsSync(pathFile)) {
    return null;
  }
  const executable = path.join(
    ELECTRON_PACKAGE_ROOT,
    "dist",
    readFileSync(pathFile, "utf8").trim(),
  );
  return existsSync(executable) ? executable : null;
}

// Tagged-stdout marker emitted by the main-process smoke branch
// (`apps/desktop/src/main/index.ts` constant `SMOKE_PROBE_TAG`). The
// matching string here MUST stay in sync; if it drifts, the line
// scanner below silently times out instead of producing a clear
// diagnostic. The marker is deliberately uppercase + bracketed so it
// can't collide with normal Electron / Chromium log output.
export const SMOKE_PROBE_TAG = "[SIDEKICKS_SMOKE_PROBE]";

// Tagged-stderr marker for the corroborating readiness breadcrumbs
// (`apps/desktop/src/main/index.ts` constant `READINESS_BREADCRUMB_TAG`).
// `did-finish-load` remains the ONLY asserted signal — `dom-ready` and
// `ready-to-show` are recorded so a timeout says WHERE the boot stopped rather
// than only that it did. Kept off stdout so the probe-line scanner above sees
// exactly one tagged line.
export const READINESS_BREADCRUMB_TAG = "[SIDEKICKS_SMOKE_READY]";

// Spec-023 acceptance: window appears within 5 seconds. We allow a
// modest buffer above that on the SPAWN side so we can distinguish a
// slow-but-passing boot (which is still a pass per the AC: the inner
// `windowMs` measurement is the load-bearing one) from a fully-stuck
// Electron process (which we want to kill rather than hang the suite).
export const WINDOW_BUDGET_MS = 5_000;

// Spawn-side backstop. Derived from measurement, not from guesswork — and
// re-derived once the fix's own CI runs supplied numbers the local box could
// not:
//
//   Unloaded, macOS 14 / M1 Pro, warm bundle, 5 consecutive runs:
//     462 / 483 / 510 / 490 / 505 ms  (in-app `windowMs` 121-131 ms)
//
//   ubuntu-latest hosted runner (4 vCPU), boot-and-probe case, three
//   consecutive green runs of THIS fixed tree:
//     4129 / 6732 / 13008 ms
//
// The local figure does not transfer: a hosted runner is 8-28x slower at the
// same work, and the spread across three runs of identical code is 3.2x.
//
// The old 15 s ceiling was set against the local number alone and described
// itself as "~30x the measured cost". Against the CI numbers it is 1.15x the
// observed worst case — a margin thin enough that runner variance alone
// re-creates the original symptom. 30 s is ~2.3x that worst case and matches
// the budget `lifecycle.gc.test.ts` already uses for the same kind of spawn.
//
// This is NOT the flake fix and does not stand in for one. The contention was
// fixed at two levels: intra-project, where this file and `lifecycle.gc.test.ts`
// ran concurrently (see `apps/desktop/vitest.config.ts`'s `main` project
// `fileParallelism` comment), and cross-PACKAGE, where turbo scheduled
// `desktop:test:smoke` alongside `runtime-daemon:test` and friends on one
// runner (see the two test steps in `.github/workflows/ci.yml`, which now give
// this project the box to itself). The three CI samples above were measured
// with the first fix in place and the second not yet, which is what their 3.2x
// spread records.
//
// The ceiling is kept at 30 s anyway, and deliberately not re-tightened on the
// strength of the post-fix samples: three runs is not a distribution, a hosted
// runner is shared infrastructure whose worst case is not ours to control, and
// the cost of a ceiling that is too generous is a slower failure while the cost
// of one that is too tight is the flake this file exists to end. This budget is
// the backstop that reports a stall; `renderDiagnosticDump` is what makes the
// next one attributable; and the inner `windowMs` assertion (WINDOW_BUDGET_MS)
// is still the load-bearing timing check and is deliberately NOT relaxed.
export const SPAWN_TIMEOUT_MS = 30_000;

// How long to wait for the X display named by `$DISPLAY` to start answering
// before we give up and refuse to spawn. On a hosted runner the display is
// stood up by the CI job (see `.github/workflows/ci.yml`, the Xvfb step),
// which already gates on readiness — this is the harness-side restatement so
// a display that is configured but dead produces an immediate, named refusal
// instead of a full spawn-budget silence.
export const DISPLAY_READY_TIMEOUT_MS = 10_000;
const DISPLAY_POLL_INTERVAL_MS = 250;

// Budget used when the test-only display override below is in force. The
// negative control asserts the SHAPE of the refusal (a named diagnostic dump
// rather than a bare timeout), not how long the harness is willing to wait, so
// it does not need to sit through the real budget.
export const FORCED_DISPLAY_READY_TIMEOUT_MS = 1_000;

// Test-only switch. Set to an X display that nothing serves, it makes the
// readiness path fail deterministically on every platform so the negative
// control can assert that the harness emits its diagnostic dump rather than a
// bare timeout. Consulted ONLY by this file; the shipped app never reads it.
export const FORCED_DISPLAY_ENV = "SIDEKICKS_SMOKE_FORCE_DISPLAY";

// Wall bound for the WHOLE at-deadline diagnostic collection, and the per-probe
// bound inside it.
//
// This is load-bearing, not hygiene. The collection runs two subprocess
// readings, and before this bound existed each carried its own 5 s
// `spawnSync` timeout — so a degraded runner (the exact case these readings
// exist to diagnose) could spend 10 s here, plus TERMINATION_GRACE_MS, inside
// an enclosing vitest budget that allowed only 5 s past SPAWN_TIMEOUT_MS. The
// diagnostic path would then be killed by vitest's generic timeout before
// `renderReadinessFailure` ever ran, and the dump this whole file exists to
// produce would be replaced by "test timed out" — losing the evidence in
// precisely the case that generated it.
//
// The probes are sub-100 ms readings in every healthy case; 1.5 s each is
// already ~15x that, and the 3 s wall bound is what makes the arithmetic
// below closed-form rather than a sum of independent worst cases.
export const DIAGNOSTIC_PROBE_TIMEOUT_MS = 1_500;
export const DIAGNOSTIC_BUDGET_MS = 3_000;

// Ceiling the stalled-boot control asserts the MEASURED collection against.
//
// Why it is not simply DIAGNOSTIC_BUDGET_MS. The budget is enforced by handing
// each probe `spawnSync`'s `timeout`, and that timeout is enforced by killing
// the child — the parent still pays the kill and the reap after the cap
// expires, and neither is bounded by anything this file owns. On a runner
// degraded enough for both probes to reach their caps (the only case where the
// budget binds at all) that tail is real. Asserting the measurement flush
// against the bound the probes were given would therefore make the control
// itself the flake, which would be a poor joke in a de-flaking change.
//
// So it carries an EXPLICIT reserve, and deliberately the same one
// TEST_TIMEOUT_SLACK_MS already provides for the close-event bound rather than
// a second fudge factor with its own name and its own drift: one reserve
// concept, used in both places, raised in one edit.
//
// It is still a real bound, not a formality. At 6 s it is 1.67x below the 10 s
// the superseded shape could reach (two independent 5 s `spawnSync` timeouts),
// so the regression this assertion exists to catch is still caught, and an
// unbounded collection is caught by a wide margin.
export const DIAGNOSTIC_COLLECTION_CEILING_MS: number =
  DIAGNOSTIC_BUDGET_MS + TEST_TIMEOUT_SLACK_MS;

// The enclosing vitest budget, DERIVED from the phases it must contain rather
// than hand-picked: the spawn budget, then the diagnostic collection, then the
// SIGTERM->SIGKILL grace, then slack. Every one of these is a named constant,
// so raising any phase raises this automatically and the enclosing budget
// cannot silently fall behind the work it encloses again.
//
// The collection term is the CEILING, not the budget. The budget is what the
// probes are handed; the ceiling is the largest collection this file asserts is
// acceptable, and an enclosure that reserved less than what its own assertions
// permit would be exactly the arithmetic hole this derivation exists to close.
//
// The display-readiness gate leads the whole sequence and is bounded
// separately, and it is a PHASE of the test like any other: it runs inside
// `spawnElectron` before the spawn deadline timer is armed, so the spawn budget
// does not contain it. Omitting it here left the worst legal run — a slow
// display gate followed by a stalled boot — outside the enclosure, which is the
// same defect as measuring the collection on one clock and bounding it on
// another, at a different phase.
export const BOOT_TEST_TIMEOUT_MS: number =
  DISPLAY_READY_TIMEOUT_MS +
  SPAWN_TIMEOUT_MS +
  DIAGNOSTIC_COLLECTION_CEILING_MS +
  TERMINATION_GRACE_MS +
  TEST_TIMEOUT_SLACK_MS;

// Test-only override making the spawn deadline fire almost immediately, so the
// stalled-boot path can be driven end to end without spending the real spawn
// budget. Set ONLY by this file's forced-stall test; when it is set the spawn
// also withholds `SIDEKICKS_SMOKE_PROBE`, so the app boots and simply never
// emits a probe line — a real stall rather than a simulated one.
export const FORCED_STALL_ENV = "SIDEKICKS_SMOKE_FORCE_SPAWN_STALL";
export const FORCED_STALL_SPAWN_TIMEOUT_MS = 2_000;
// The forced-stall override shortens the SPAWN budget and nothing else, so this
// enclosure carries the same real display-readiness term the boot budget does.
export const FORCED_STALL_TEST_TIMEOUT_MS: number =
  DISPLAY_READY_TIMEOUT_MS +
  FORCED_STALL_SPAWN_TIMEOUT_MS +
  DIAGNOSTIC_COLLECTION_CEILING_MS +
  TERMINATION_GRACE_MS +
  TEST_TIMEOUT_SLACK_MS;

export interface SmokeProbe {
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

export interface SpawnResult {
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
  // The spawn budget this particular spawn actually ran under. Carried rather
  // than read back from SPAWN_TIMEOUT_MS so the failure text states the deadline
  // that really elapsed, which the forced-stall override changes.
  readonly spawnBudgetMs: number;
  // Whether THIS harness's deadline fired. Recorded rather than inferred from
  // `signal`, because the inference is wrong: the direct child is the
  // `node_modules/.bin/electron` Node shim, which CATCHES SIGTERM, forwards it
  // to the real binary, prints "... exited with signal SIGTERM" and then exits
  // with CODE 1 and no signal of its own. A `signal !== null` test therefore
  // misses every deadline kill on the direct spawn path and lets the diagnosis
  // fall through to the `exitCode === 1` arm, which reports "`app.whenReady()`
  // rejected" — a startup failure that did not happen. (This was latent while
  // CI wrapped each spawn in `xvfb-run`: the direct child was then a shell,
  // which does die by signal. Moving CI to a job-level display made the shim
  // the direct child on Linux too, so the flag is what keeps the diagnosis
  // right on the platform the gate runs on.)
  readonly timedOut: boolean;
  // Wall time the at-deadline diagnostic collection actually spent, or null if
  // the deadline never fired. Exposed so the bound can be asserted against a
  // measurement of itself rather than inferred from total elapsed time.
  readonly diagnosticCollectionMs: number | null;
  // The `$DISPLAY` the child was given, or undefined when none was set. Exposed
  // so a test can assert the child could not have used the ambient display.
  readonly childDisplay: string | undefined;
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

// Finds a display number nothing has claimed, for the dead-display control.
//
// A hardcoded `:987` is not known-dead on a shared host: CI runners, tmpfs that
// outlives a crashed server, and a colleague's own Xvfb can all leave a stale
// `/tmp/.X11-unix/X987`, and a stale socket defeats the socket-existence check
// this control exists to drive — the gate would report the display as ready and
// the test would fail for a reason that has nothing to do with the code.
//
// So the number is RESERVED at test time instead of assumed: scan downward from
// a high number and take the first whose X lock file AND unix socket are both
// absent. Both are checked because either alone can be stale independently —
// the lock is what a live server holds, the socket is what the gate reads.
//
// This is a scan, not a lock; nothing stops a server appearing between the
// check and the spawn. On a test host that is not a real risk, and the
// alternative — actually binding a display to prove it is free — would mean
// standing up an X server inside a test whose entire subject is not having one.
export function reserveDeadDisplay(): string {
  for (let displayNumber = 999; displayNumber > 900; displayNumber -= 1) {
    const lockPath = `/tmp/.X${String(displayNumber)}-lock`;
    const socketPath = `/tmp/.X11-unix/X${String(displayNumber)}`;
    if (!existsSync(lockPath) && !existsSync(socketPath)) {
      return `:${String(displayNumber)}`;
    }
  }
  throw new Error(
    "No unclaimed X display number in :901-:999 — refusing to run the " +
      "dead-display control against a number something else may own.",
  );
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
// `externalProbeDeadline` gates the two subprocess-backed readings AND bounds
// them. They are the expensive half and they are only worth paying for on the
// failure path, so the at-spawn capture passes `null` — cheap readings only,
// boot budget untouched — while the at-deadline capture passes a deadline,
// because by then the budget is already spent and the readings are the whole
// point.
//
// It is an ABSOLUTE instant supplied by the caller, not a duration this
// function turns into one, and that is the point: the caller also measures how
// long the collection took, and when the deadline was computed here the
// measurement started one instant earlier than the bound it was compared
// against. The cheap readings above sit in that gap, so a collection whose two
// probes each ran to their cap measured strictly MORE than the budget it was
// asserted to honour — the bound and its own measurement disagreed by
// construction. One clock, one constant, set at the call site.
//
// The subprocess readings share ONE wall budget (DIAGNOSTIC_BUDGET_MS) rather
// than carrying independent per-call timeouts, so the collection's worst case
// is a constant this file can add to the enclosing test budget instead of a
// sum that can outgrow it. Each reading gets whatever is left, capped at
// DIAGNOSTIC_PROBE_TIMEOUT_MS; a reading with no budget left is RECORDED as
// skipped rather than silently omitted, because a dump that quietly drops a
// line is exactly the failure mode this file was written to end.
//
// The process tree is taken FIRST because it is the perishable reading: the
// caller runs this immediately before SIGTERM, and once the tree is gone `ps`
// has nothing to report, while the display reading is still available
// afterwards. Under a shared budget, ordering decides which reading survives a
// slow runner, so the perishable one goes first.
function captureDiagnostics(
  label: string,
  child: ChildProcess | null,
  externalProbeDeadline: number | null,
): string[] {
  const readings = [
    `[${label}] platform=${process.platform} cpus=${String(availableParallelism())} ` +
      `loadavg=${loadavg()
        .map((value) => value.toFixed(2))
        .join("/")}`,
    `[${label}] DISPLAY=${resolvedDisplay() ?? "<unset>"} ` +
      `spawnPath=${needsXvfb() ? "xvfb-run -a" : "direct"}`,
  ];
  const remainingProbeBudgetMs = (): number =>
    externalProbeDeadline === null
      ? 0
      : Math.min(DIAGNOSTIC_PROBE_TIMEOUT_MS, externalProbeDeadline - Date.now());

  if (externalProbeDeadline !== null && child?.pid !== undefined && process.platform !== "win32") {
    // The spawn leads its own process group, so `-g <pid>` is exactly this
    // spawn's tree and nothing else on the runner.
    const budgetMs = remainingProbeBudgetMs();
    if (budgetMs <= 0) {
      readings.push(`[${label}] process tree skipped — diagnostic budget exhausted`);
    } else {
      const processTree = spawnSync(
        "ps",
        ["-o", "pid,ppid,stat,etime,comm", "-g", String(child.pid)],
        { encoding: "utf8", timeout: budgetMs },
      );
      readings.push(
        `[${label}] process tree (pgid=${String(child.pid)}):\n${processTree.stdout ?? "<unavailable>"}`,
      );
    }
  }

  const display = resolvedDisplay();
  if (externalProbeDeadline !== null && display !== undefined && process.platform !== "win32") {
    if (xdpyinfoMissing) {
      // No `x11-utils` on the ubuntu-24.04 runner image, so report the socket
      // reading actually used rather than a tool reading we cannot take. This
      // arm spends no subprocess and so needs no budget check.
      const socketPath = localDisplaySocketPath(display);
      readings.push(
        `[${label}] display socket ${socketPath ?? "<unprobeable display>"} ` +
          `present=${socketPath === null ? "<unknown>" : String(existsSync(socketPath))} ` +
          `(xdpyinfo unavailable)`,
      );
    } else {
      const budgetMs = remainingProbeBudgetMs();
      if (budgetMs <= 0) {
        readings.push(`[${label}] xdpyinfo skipped — diagnostic budget exhausted`);
      } else {
        const probe = spawnSync("xdpyinfo", ["-display", display], {
          encoding: "utf8",
          timeout: budgetMs,
        });
        const dimensions = /dimensions:\s+(\S+)/.exec(probe.stdout ?? "")?.[1];
        readings.push(
          `[${label}] xdpyinfo status=${String(probe.status)} ` +
            `dimensions=${dimensions ?? "<none>"}`,
        );
      }
    }
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

/**
 * Line-buffered scanner for the readiness breadcrumb trail on ONE stream.
 *
 * Exported for direct unit testing, and stateful by nature — a chunk boundary
 * can fall anywhere, including inside the tag itself, so the unfinished tail of
 * each chunk has to be carried into the next one. The probe-line scanner in
 * `spawnElectron` has always done this; the breadcrumb scanner did not, and
 * split a straddling breadcrumb into two fragments that both failed to match,
 * silently losing the very evidence the trail exists to provide.
 *
 * One instance PER STREAM. Sharing an instance across stdout and stderr would
 * splice the tail of one stream onto the head of the other and synthesise a
 * line neither of them emitted.
 */
export class ReadinessLineScanner {
  #pending = "";

  /** Feeds one chunk; returns the breadcrumbs completed by it, in order. */
  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines = this.#pending.split("\n");
    // `pop()` yields the unterminated trailing piece when the chunk does not
    // end on a newline, or "" when it does — both are the right carry-forward.
    this.#pending = lines.pop() ?? "";
    const breadcrumbs: string[] = [];
    for (const line of lines) {
      const marker = line.indexOf(READINESS_BREADCRUMB_TAG);
      if (marker < 0) continue;
      breadcrumbs.push(line.slice(marker + READINESS_BREADCRUMB_TAG.length).trim());
    }
    return breadcrumbs;
  }
}

export function spawnElectron(): Promise<SpawnResult> {
  const startedAt = Date.now();

  // Forced-stall override, set only by this file's stalled-boot test. It does
  // two things together, and both are needed for the test to be honest: it
  // shrinks the spawn deadline so the path runs in seconds rather than the full
  // spawn budget, and (below) it withholds the probe opt-in so the boot really
  // does produce no probe line. Neither substitutes a fake for the code under
  // test — the deadline, the bounded diagnostic collection, the process-group
  // termination and the failure renderer are all the production ones.
  const forcedStall = process.env[FORCED_STALL_ENV] !== undefined;
  const spawnBudgetMs = forcedStall ? FORCED_STALL_SPAWN_TIMEOUT_MS : SPAWN_TIMEOUT_MS;

  // Strip an inherited probe opt-in when forcing a stall; see the `env` block.
  const { SIDEKICKS_SMOKE_PROBE: _inheritedProbeOptIn, ...envWithoutProbe } = process.env;
  const spawnBaseEnv = forcedStall ? envWithoutProbe : process.env;

  // What the child's `$DISPLAY` will be. Resolved once here so the value the
  // harness gated on and the value the child receives cannot diverge.
  const childDisplay = resolvedDisplay();

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

  /**
   * The ONE remover of this spawn's profile, reached from all three paths.
   *
   * The refusal before the spawn, the settlement after `close`, and the
   * settle-time disposer registered below all call this same function rather
   * than each spelling `rmSync` for itself. `force: true` makes it idempotent,
   * which is what lets two of those paths run on one spawn — a `close` arriving
   * after a spawn `error`, or a settlement that already removed the directory
   * before the disposer asks again.
   *
   * Best-effort, because it always was: a leftover temporary profile is a
   * housekeeping fact, and raising it here would replace whichever result the
   * caller actually came for.
   */
  const removeProfileDirectory = (): void => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // See above: the caller's own result is the one that explains the run.
    }
  };

  // Readiness gate. A display that is named but not serving is the one boot
  // precondition this harness can check cheaply and BEFORE spawning, so it is
  // checked here rather than discovered as a spawn-budget silence. On CI the job-level
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
        diagnostics: captureDiagnostics("refused-before-spawn", null, null),
        spawnBudgetMs,
        timedOut: false,
        diagnosticCollectionMs: null,
        childDisplay,
      };
      removeProfileDirectory();
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
  const spawnCommand = needsXvfb() ? "xvfb-run" : ELECTRON_BIN;
  const spawnArguments = needsXvfb() ? ["-a", ELECTRON_BIN, ...electronArgs] : electronArgs;

  return new Promise<SpawnResult>((resolve) => {
    // Through the shared owner rather than a bare `spawn`, so the child's
    // lifetime is bound to this TEST and not to the timers below: the deadline
    // covers a stalled boot, and the settle-time registration covers every
    // other way the test ends — a pass, an assertion failure, and vitest's own
    // timeout kill, none of which runs a timer armed for a stall.
    const managed = spawnManagedElectronChild({
      command: spawnCommand,
      args: spawnArguments,
      cwd: PACKAGE_ROOT,
      env: {
        // Under the forced-stall override the probe opt-in is DROPPED from the
        // inherited environment, not merely left unset below. A developer with
        // `SIDEKICKS_SMOKE_PROBE=1` exported in their shell would otherwise
        // have it inherited through the spread, the app would emit a real probe
        // line, and the stalled-boot control would quietly stop testing a
        // stall. Same guard, and same reason, as `lifecycle.gc.test.ts`'s
        // `envWithoutSmoke`.
        ...spawnBaseEnv,
        // Pinned rather than inherited so the child cannot fall back to the
        // ambient display. This matters exactly when the readiness gate has
        // regressed: without it a spawn that should have been refused would
        // open on the developer's real display and pass, hiding the regression.
        ...(childDisplay === undefined ? {} : { DISPLAY: childDisplay }),
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
        // Withheld under the forced-stall override: with no probe opt-in the
        // app boots normally and simply never emits a probe line, which is a
        // REAL stall for this harness rather than a simulated one, and is what
        // lets the stalled-boot test drive the deadline path end to end. The
        // inherited value is stripped above, so this is the only source.
        ...(forcedStall ? {} : { SIDEKICKS_SMOKE_PROBE: "1" }),
        // Emit the corroborating readiness breadcrumbs (`dom-ready`,
        // `ready-to-show`) beside the asserted `did-finish-load`. Opt-in per
        // invocation for the same reason the probe itself is: the main process
        // must never take a test-only code path it was not explicitly asked to.
        SIDEKICKS_SMOKE_TRACE_READINESS: "1",
        // Reveal the window without activating the application: an ordinary
        // reveal on macOS steals focus and switches the operator's Space on
        // every spawn. Honoured by the smoke build only (see
        // `src/main/window-reveal.ts`).
        [UNOBTRUSIVE_WINDOWS_ENV]: "1",
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
    });
    // The profile outlives the child unless something removes it on the paths
    // the child's own events do not reach. `spawnManagedElectronChild` already
    // bound the KILL to this test; this binds the REMOVAL to it, after the kill
    // has landed — see `electron-child-cleanup.ts` for why the wait between them
    // is load-bearing rather than defensive.
    cleanUpAfterChildAtSettleTime(managed, removeProfileDirectory);

    // The stream wiring below reads the handle; every kill goes through
    // `managed`, which owns the process group the detached spawn created.
    const child = managed.child;

    let stdout = "";
    let stderr = "";
    let combinedOutput = "";
    let probe: SmokeProbe | null = null;
    const readinessBreadcrumbs: string[] = [];
    const diagnostics: string[] = captureDiagnostics("at-spawn", child, null);
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
    let deadlineFired = false;
    let collectionMs: number | null = null;

    const spawnDeadline = setTimeout(() => {
      // The spawn timeout (`spawnBudgetMs`) is a backstop — the in-app window
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
      deadlineFired = true;
      // Timed and RECORDED, not merely bounded. The recorded figure is what the
      // stalled-boot test asserts on, which keeps that assertion measuring the
      // thing it claims — the collection's own cost — instead of total wall
      // time, whose dominant term is Electron's teardown after SIGTERM and is
      // neither bounded here nor ours to control. It also earns its place in
      // the dump: a collection that ran long is itself a reading about the
      // runner.
      const collectionStartedAt = Date.now();
      const atDeadline = captureDiagnostics(
        "at-deadline",
        child,
        // The SAME instant the measurement below starts from, plus the budget.
        // Deriving the deadline here rather than inside the callee is what
        // makes `collectionMs <= DIAGNOSTIC_BUDGET_MS` a claim about one clock
        // instead of two.
        collectionStartedAt + DIAGNOSTIC_BUDGET_MS,
      );
      collectionMs = Date.now() - collectionStartedAt;
      diagnostics.push(
        ...atDeadline,
        `[at-deadline] collection took ${String(collectionMs)}ms ` +
          `(budget ${String(DIAGNOSTIC_BUDGET_MS)}ms, ` +
          `ceiling ${String(DIAGNOSTIC_COLLECTION_CEILING_MS)}ms)`,
      );
      managed.terminateWithEscalation(TERMINATION_GRACE_MS);
    }, spawnBudgetMs);

    // Single settle path so both timers and the temporary profile are
    // disposed exactly once whichever terminal event fires first. This is the
    // FAST path and not the only one: it runs when a terminal event arrived, and
    // the settle-time registration above is what covers the outcomes where none
    // does — vitest's own timeout being the one that left profiles behind.
    const settle = (result: SpawnResult): void => {
      clearTimeout(spawnDeadline);
      // Releases the escalation timer and, on the ordinary `close` path, signals
      // NOTHING: by then the child is reaped and its pid — and the group it led
      // — are the operating system's to reissue, which is why disposal reads the
      // `close` `ManagedElectronChild` recorded rather than asking for a kill.
      // On the spawn-`error` path it is the only thing that runs at all.
      managed.dispose();
      removeProfileDirectory();
      resolve(result);
    };

    // Breadcrumbs are emitted by the main process on STDERR, but the
    // `xvfb-run` fallback merges the child's stderr into stdout, so both
    // streams are scanned. Ordering within a stream is preserved; the offsets
    // the main process stamps on each line are what makes the sequence
    // readable regardless of interleaving.
    // One scanner per stream — see `ReadinessLineScanner` for why they are not
    // shared.
    const stdoutReadiness = new ReadinessLineScanner();
    const stderrReadiness = new ReadinessLineScanner();

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      combinedOutput += text;
      readinessBreadcrumbs.push(...stdoutReadiness.push(text));
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
        const probeTagIndex = line.indexOf(SMOKE_PROBE_TAG);
        if (probeTagIndex < 0) continue;
        const payload = line.slice(probeTagIndex + SMOKE_PROBE_TAG.length).trim();
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
      readinessBreadcrumbs.push(...stderrReadiness.push(text));
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
        spawnBudgetMs,
        timedOut: deadlineFired,
        diagnosticCollectionMs: collectionMs,
        childDisplay,
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
        spawnBudgetMs,
        timedOut: deadlineFired,
        diagnosticCollectionMs: collectionMs,
        childDisplay,
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
export function diagnoseMissingProbe(result: SpawnResult): string {
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
  if (result.combinedOutput.includes("failed to load sidekicks-renderer://")) {
    return (
      "the window was created but the bundle never loaded over the renderer " +
      "scheme, so the preload never executed and `did-finish-load` never " +
      "fired. Either the scheme was not registered before ready or the " +
      "handler refused `index.html` — the handler answers an escape with an " +
      "empty-bodied 403 and a miss with an empty-bodied 404, so the renderer " +
      "side reports only the failure, never the reason."
    );
  }
  if (result.combinedOutput.includes(`${SMOKE_PROBE_TAG} executeJavaScript failed`)) {
    return "the renderer document loaded but the probe expression never evaluated in it.";
  }
  // Ahead of the breadcrumb arm below, and deliberately so: this failure
  // happens AFTER `did-finish-load`, so the breadcrumb arm would absorb it and
  // report a hung `executeJavaScript` round trip — which would be exactly
  // false. The round trip returned; the main-process readback is what failed.
  if (result.combinedOutput.includes(`${SMOKE_PROBE_TAG} index fetch failed`)) {
    return (
      "the renderer loaded and the probe expression evaluated, but the main " +
      "process could not fetch `sidekicks-renderer://app/index.html` back " +
      "through its own handler to read the CSP header."
    );
  }
  // `did-finish-load` fired and the probe line still never arrived. That is a
  // materially different fault from a boot that never loaded: the document IS
  // up, the callback DID run, and what did not come back is the
  // `executeJavaScript` round trip into the renderer. Checked ahead of the
  // signal arm because it is the more specific reading of the same
  // terminated-at-deadline evidence, and the generic arm below would otherwise
  // absorb it and report "`did-finish-load` never fired" — which would be
  // exactly false.
  if (result.readinessBreadcrumbs.some((event) => event.includes("did-finish-load"))) {
    return (
      "the renderer finished loading and the probe callback ran, but the " +
      "`executeJavaScript` round trip never resolved — so this is a hung probe " +
      "evaluation, NOT a renderer that failed to load. Readiness reached: " +
      `${result.readinessBreadcrumbs.join(", ")}.`
    );
  }
  // Keyed on the recorded deadline, NOT on `signal !== null`. See
  // `SpawnResult.timedOut`: on the direct spawn path the electron shim catches
  // SIGTERM and exits with code 1, so a signal test would silently hand this
  // case to the `exitCode === 1` arm below and report a startup failure that
  // never happened.
  if (result.timedOut) {
    // The breadcrumbs turn one timeout shape into several distinguishable ones:
    // nothing at all (the browser process never got the renderer up), a
    // `dom-ready` with no `did-finish-load` (the document parsed but a
    // subresource never settled), or neither with a `ready-to-show` (the
    // window surfaced against a document that never parsed). The
    // `did-finish-load` case is split out above.
    const reached =
      result.readinessBreadcrumbs.length > 0
        ? `Readiness reached: ${result.readinessBreadcrumbs.join(", ")}.`
        : "No readiness event fired at all — the renderer never reached `dom-ready`.";
    // How the tree actually died is itself a reading: killed by signal means the
    // direct child took it, whereas an exit code means the shim caught SIGTERM,
    // forwarded it, and reported the real binary's death.
    const disposition =
      result.signal !== null
        ? `terminated (${result.signal})`
        : `terminated (SIGTERM; the electron shim forwarded it and exited ${String(result.exitCode)})`;
    return (
      `the process was still running at the ${String(result.spawnBudgetMs)}ms deadline and was ` +
      `${disposition} — \`did-finish-load\` never fired. ${reached}`
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
export function renderReadinessFailure(result: SpawnResult): string {
  return (
    `Desktop shell never became ready: ${diagnoseMissingProbe(result)}\n` +
    `No \`${SMOKE_PROBE_TAG}\` line arrived within ${String(result.spawnBudgetMs)}ms.\n` +
    `Exit code: ${String(result.exitCode)}, signal: ${String(result.signal)}, elapsed: ${String(result.elapsedMs)}ms.\n` +
    renderDiagnosticDump(result)
  );
}
