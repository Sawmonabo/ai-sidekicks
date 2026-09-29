// The Electron spawn-and-probe harness for the smoke tier.
//
// Everything here is about getting a probe reading out of a real Electron process:
// resolving the binary, spawning it on a per-spawn profile, scanning the tagged lines,
// and killing the tree. None of it decides whether a reading is acceptable; that is the
// suite's. Reading the output and explaining a missing probe is
// `smoke-probe-diagnosis.ts`, and the display gate is `display-readiness.ts`.
//
// The harness asserts nothing. It reaches one test-framework symbol, only through
// `electron-child.ts`, which registers the settle-time kill on `onTestFinished`, so a
// stalled Electron cannot outlive the test that spawned it. It drives the real binary:
// `src/main/probes/smoke-probe.ts` is the other half of the same contract and emits the
// tagged lines the diagnosis module parses.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UNOBTRUSIVE_WINDOWS_ENV } from "@main/windows/window-reveal.js";
import { SMOKE_PROBE_TAG } from "@shared/probe-tags.js";
import { spawnChildCleanedUpAtSettleTime } from "./electron-child-cleanup.js";
import { TEST_TIMEOUT_SLACK_MS } from "./electron-child.js";
import { TERMINATION_GRACE_MS } from "./managed-electron-child.js";
import { SPAWNED_TREE_HOST_QUERY_CEILING_MS } from "./process-tree/budget.js";
import {
  DISPLAY_READY_TIMEOUT_MS,
  awaitDisplayReady,
  needsXvfb,
  resolvedDisplay,
} from "./display-readiness.js";
import {
  DIAGNOSTIC_BUDGET_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  ReadinessLineScanner,
  captureDiagnostics,
} from "./smoke-probe-diagnosis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Package root — `apps/desktop/`. This module lives at
// `apps/desktop/tests/helpers/smoke-probe-harness.ts`; `../..` lands on the package
// root, which every path below is resolved against.
//
// Exported for the same reason the three entry paths below it are: the sibling
// GC harness spawns with it as its `cwd`, and a second `path.resolve(__dirname,
// "../..")` beside this one would be two derivations of one root that drift the
// moment either module moves.
export const PACKAGE_ROOT: string = path.resolve(__dirname, "../..");

// The `electron-vite build` output paths (per `apps/desktop/electron.vite.
// config.ts`'s per-target `outDir`). The build pipeline swapped from the
// original `tsc -b` posture to
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

// The window must appear within 5 seconds. We allow a
// modest buffer above that on the SPAWN side so we can distinguish a
// slow-but-passing boot (which is still a pass: the inner
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
// the budget `gc-probe.ts` already uses for the same kind of spawn.
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
//
// The SPAWNED TREE'S OWN HOST QUERIES are the second phase of that same shape
// and were omitted for the same reason it was easy to miss: they are not the
// harness's own code. They are the blocking `ps` or PowerShell reads a managed
// child performs — the root capture inside `spawnManagedElectronChild` after the
// spawn and before this file arms the deadline below, the descendant capture
// this file takes when its child first speaks, and the intersection the root's
// exit runs — so a degraded host spends their whole ceiling with neither the
// display gate nor the spawn budget containing them. `process-tree/budget.ts`
// derives the term, platform-conditionally, from the same predicate that decides
// whether those readings happen at all. Both uncontained phases are terms here.
export const BOOT_TEST_TIMEOUT_MS: number =
  DISPLAY_READY_TIMEOUT_MS +
  SPAWNED_TREE_HOST_QUERY_CEILING_MS +
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
  SPAWNED_TREE_HOST_QUERY_CEILING_MS +
  FORCED_STALL_SPAWN_TIMEOUT_MS +
  DIAGNOSTIC_COLLECTION_CEILING_MS +
  TERMINATION_GRACE_MS +
  TEST_TIMEOUT_SLACK_MS;

interface SmokeProbe {
  readonly ok: boolean;
  readonly windowMs: number;
  readonly probe: {
    readonly desktopBridge: string;
    readonly require: string;
    readonly process: string;
    readonly global: string;
    // The origin readings. These exist only
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
  // The sibling `gc-probe.ts` isolates its profile for exactly
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
    //
    // The profile outlives the child unless something removes it on the paths
    // the child's own events do not reach, so the same call binds the REMOVAL to
    // this test after the kill has landed — and releases it outright on the one
    // path where there is no child to wait for, a settle-time registration that
    // itself refuses. Both halves are `electron-child-cleanup.ts`'s, which is
    // why this is one call and not two.
    const managed = spawnChildCleanedUpAtSettleTime(
      {
        command: spawnCommand,
        args: spawnArguments,
        cwd: PACKAGE_ROOT,
        env: {
          // Under the forced-stall override the probe opt-in is DROPPED from the
          // inherited environment, not merely left unset below. A developer with
          // `SIDEKICKS_SMOKE_PROBE=1` exported in their shell would otherwise
          // have it inherited through the spread, the app would emit a real probe
          // line, and the stalled-boot control would quietly stop testing a
          // stall. Same guard, and same reason, as `gc-probe.ts`'s
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
      },
      removeProfileDirectory,
    );

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
      // Capture the environment BEFORE signaling: once SIGTERM lands the
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
      // OUTPUT IS THIS HARNESS'S EVIDENCE THAT THE TREE IS UP, and the tree is
      // what a rootless kill has to be addressed by once the launcher shim is
      // reaped. Recorded once, here, because the root's own `exit` is already
      // too late to record anything — `spawned-tree-record.ts` has why, and why
      // the enclosing budget above reserves exactly one listing for this.
      managed.captureTreeDescendants();
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
