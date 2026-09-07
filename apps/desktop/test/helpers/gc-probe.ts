// The Electron spawn-and-probe harness for the BrowserWindow GC probe.
//
// Extracted from `../lifecycle.gc.test.ts`, which had grown past this package's
// split threshold with its spawner taking more of the file than its assertions.
// The split is by ROLE and not by size, the same cut `electron-probe.ts` records
// for the smoke probe: everything here is about GETTING a probe reading out of a
// real Electron process — isolating a profile, arranging the activation gates,
// spawning through the one owner, scanning the tagged line, and releasing what
// the spawn was holding — and none of it decides whether a reading is
// acceptable. That decision is the suite's, and it stayed there.
//
// It is a SIBLING of `electron-probe.ts` rather than a second copy of it. Those
// two probes read different readings, arrange different activation gates, and
// carry different diagnostics, so one function could not serve both without a
// mode flag; what they genuinely share they take from one home — the bundle
// entry paths and the package root below, and the spawn door itself, which is
// the chokepoint this file's own suite (`electron-spawn-chokepoint.test.ts`)
// holds every module under `test/` to.
//
// The harness asserts nothing, deliberately. A helper that could fail a test
// would be a second place a probe failure can come from; the one test-framework
// symbol it reaches is a teardown registrar, and only through
// `electron-child.ts`.
//
// MECHANISM
//   The main entrypoint exposes a second compile-time-gated probe path
//   (`SIDEKICKS_GC_PROBE=1`) that does NOT exit immediately. Instead it
//   schedules `runGcProbe` on a fresh event-loop tick (so the `.then(...)`
//   arrow's locals can unwind first) and the probe iterates K=20 cycles of:
//     1. Two bare `globalThis.gc()` calls (precise major collection — see
//        ADR-024 §Antithesis for why `gc(true)` is rejected: that signature
//        is a MINOR scavenge per V8's `gc-extension.cc`, leaving old-
//        generation objects intact).
//     2. An 8 MB Uint8Array allocation to pressure old-generation promotion
//        of the throwaway buffer + reclaim of the prior iteration's buffer.
//     3. Two more `globalThis.gc()` calls.
//     4. A 50 ms wait so any C++ destructor task posted by a V8 weak
//        callback can run.
//     5. A `v8.queryObjects(BrowserWindow, { format: "count" })` sample.
//   The branch also registers a probe-scoped `window-all-closed` listener
//   that toggles a module-scope flag — the listener fires before the
//   pre-existing `app.quit()` handler (EventEmitter listener order is
//   registration order), so the flag captures the event even if the probe's
//   `console.log` would otherwise lose the race against process exit. On
//   completion the probe emits a single `[SIDEKICKS_GC_PROBE]` JSON line
//   to stdout (including `allClosedFired` from the flag) and calls
//   `app.exit(0)`.
//
// ACTIVATION REQUIREMENTS (the production-safety multi-gate):
//   1. Bundle built with `electron-vite build --mode=smoke` (sets
//      `__SIDEKICKS_SMOKE_BUILD__` to `true` via Vite `define`). A release
//      bundle has the entire probe body tree-shaken out — running the suite
//      against a release bundle would silently time out.
//   2. Spawn environment carries `SIDEKICKS_GC_PROBE=1` AND does NOT
//      carry `SIDEKICKS_SMOKE_PROBE=1` (the smoke branch is checked first
//      in the if/else if cascade in `apps/desktop/src/main/index.ts`).
//   3. Electron started with `--js-flags=--expose-gc` so `globalThis.gc()`
//      is wired. Without this flag the probe's GC-pressure loop is a
//      no-op (V8 will collect on its own schedule) and the suite becomes
//      non-deterministic — which is why the reading carries
//      `globalGcAvailable` for the suite to gate on explicitly.
//
// LINUX CI HANDLING — same posture as the smoke harness. CI stands up ONE
// Xvfb for the whole job and exports `$DISPLAY` before any test runs (see
// `.github/workflows/ci.yml`), so `needsXvfb()` is false there and this spawns
// the binary directly. The `xvfb-run -a` arm below remains the fallback for a
// Linux contributor running with no display server of their own.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { UNOBTRUSIVE_WINDOWS_ENV } from "../../src/main/window-reveal.js";
import { spawnChildCleanedUpAtSettleTime } from "./electron-child-cleanup.js";
import { IDENTITY_CAPTURE_CEILING_MS, TEST_TIMEOUT_SLACK_MS } from "./electron-child.js";
import { ELECTRON_BIN, MAIN_ENTRY, PACKAGE_ROOT } from "./electron-probe.js";
import { TERMINATION_GRACE_MS } from "./managed-electron-child.js";

/** The line prefix the probe tags its single JSON reading with. */
export const GC_PROBE_TAG = "[SIDEKICKS_GC_PROBE]";

// K=20 iterations × ~150 ms each ≈ 3 s probe runtime. Plus Electron boot
// (typically 1-2 s on Linux runners). 30 s is a generous backstop.
export const SPAWN_TIMEOUT_MS = 30_000;

/**
 * The enclosing vitest budget, DERIVED from the phases it must contain rather
 * than written down: the spawn's own blocking identity capture, then the spawn
 * budget, then the SIGTERM-to-SIGKILL grace, then the shared reserve. The
 * capture leads because it is a phase no spawn deadline contains — it runs
 * inside `spawnManagedElectronChild`, before the deadline below is armed — and
 * omitting it left the worst legal run outside this enclosure by exactly its
 * ceiling. The relation is the one `TEST_TIMEOUT_SLACK_MS` states —
 * the suite's own deadline has to fire first, because a vitest timeout tears
 * the worker down and every pending timer in it, and the Electron that timer
 * was going to kill is then reparented to init. That is not hypothetical here:
 * four such orphans, carrying this harness's own `sidekicks-gc-test-` profile
 * prefix, were found 25 minutes after the run that spawned them.
 *
 * The settle-time kill registered by `spawnManagedElectronChild`, and the
 * settle-time profile removal registered beside it, are what make the spawn
 * survivable even if this arithmetic is ever wrong again. Both, not either: the
 * derivation keeps the diagnostic path reachable, and the hooks keep the process
 * and its directory bounded when it is not.
 */
export const GC_TEST_TIMEOUT_MS: number =
  IDENTITY_CAPTURE_CEILING_MS + SPAWN_TIMEOUT_MS + TERMINATION_GRACE_MS + TEST_TIMEOUT_SLACK_MS;

/** One reading emitted by the main process's GC probe branch. */
interface GcProbe {
  readonly ok: boolean;
  readonly queryObjectsAvailable: boolean;
  readonly globalGcAvailable: boolean;
  readonly iterations: number;
  readonly counts: readonly number[];
  readonly min: number;
  readonly max: number;
  /** Windows open when the loop ended; the per-window delta's denominator. */
  readonly windowsOpened: number;
  /** The loop's last sample, taken with every window still open. */
  readonly openCount: number;
  /** One sample after every window closed, the close unwound, and a collection. */
  readonly closedCount: number;
  readonly allClosedFired: boolean;
}

/** What one spawn produced, reading or not, with the context to diagnose it. */
interface GcProbeSpawnResult {
  readonly probe: GcProbe | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
}

function needsXvfb(): boolean {
  return process.platform === "linux" && !process.env["DISPLAY"];
}

/**
 * Spawn Electron on the GC probe path and resolve with what it emitted.
 *
 * Resolves rather than rejects on every outcome — a missing reading, a spawn
 * error, a deadline kill — because the suite's Shape-C diagnosis needs the
 * stdout, stderr and exit code that explain which of those happened, and a
 * rejection here would replace them with a stack.
 */
export function spawnElectronGcProbe(): Promise<GcProbeSpawnResult> {
  const startedAt = Date.now();

  // Per-spawn userData dir isolates this probe's Electron instance from every
  // other Electron running on the default profile — a sibling suite in a
  // parallel vitest worker, a second checkout, a developer's unrelated
  // Electron app, an orphan from an earlier terminated run. They would
  // otherwise race on `~/Library/Application Support/Electron/SingletonLock`
  // (or its $XDG_CONFIG_HOME equivalent on Linux): whichever starts
  // second sees `gotTheLock === false`, calls `app.quit()`, and exits
  // with code 0 before the probe runs — a Shape-C failure that has nothing
  // to do with BrowserWindow GC reachability.
  // `mkdtempSync` returns a unique path; `removeProfileDirectory` below is what
  // takes it off disk, from both of the paths that can reach it.
  // `electron-probe.ts` isolates its own profile the same way, for the
  // same reason.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sidekicks-gc-test-"));

  /**
   * The ONE remover of this spawn's profile, reached from both paths.
   *
   * The settlement after a terminal event and the settle-time disposer
   * registered below call this same function rather than each spelling `rmSync`
   * for itself, and `force: true` is what lets both run on one spawn — the
   * settlement having already removed the directory before the disposer asks
   * again. Best-effort, because a leftover temporary profile is a housekeeping
   * fact and raising it would replace the result the reader came for.
   */
  const removeProfileDirectory = (): void => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // See above: the test's own result is the one that explains the run.
    }
  };

  // `--js-flags=--expose-gc` MUST precede the entry script so Electron
  // forwards it to the underlying Chromium/V8 child. The probe's GC-pressure
  // loop is a no-op without it; the suite asserts `globalGcAvailable === true`
  // to fail loudly rather than silently produce non-deterministic results.
  const electronArgs = ["--js-flags=--expose-gc", `--user-data-dir=${userDataDir}`, MAIN_ENTRY];
  const spawnCommand = needsXvfb() ? "xvfb-run" : ELECTRON_BIN;
  const spawnArguments = needsXvfb() ? ["-a", ELECTRON_BIN, ...electronArgs] : electronArgs;

  // Strip SIDEKICKS_SMOKE_PROBE from the spawn env so the smoke branch
  // (checked first in the if/else if cascade in the main entrypoint) does
  // NOT fire ahead of the GC probe. This guards against a developer's
  // shell having SIDEKICKS_SMOKE_PROBE exported, or a future CI matrix
  // that runs both probes back-to-back.
  const { SIDEKICKS_SMOKE_PROBE: _drop, ...envWithoutSmoke } = process.env;

  return new Promise<GcProbeSpawnResult>((resolve) => {
    // Through the shared owner, which is what makes this spawn survivable.
    // Two things it supplies that the superseded shape could not: the child
    // leads its own process group, so the kill reaches the browser process
    // behind the `node_modules/.bin/electron` shim rather than orphaning it —
    // SIGKILL is unforwardable, so signalling the shim alone was how the
    // measured orphans were made — and the kill is registered on
    // `onTestFinished`, so it runs on every outcome the test has rather than
    // only on the one a timer was armed for.
    //
    // The profile outlives the child unless something removes it on the paths
    // the child's own events do not reach, so the same call binds the REMOVAL to
    // the test after the kill has landed. Without it a vitest timeout — the one
    // outcome that runs neither `close` nor `error` — left the
    // `sidekicks-gc-test-` profile on disk for the rest of the run to
    // accumulate, which is how four of them were found beside four orphans; and
    // a settle-time registration that itself REFUSES is the path where there is
    // no child to wait for at all, which the same door releases outright.
    const managed = spawnChildCleanedUpAtSettleTime(
      {
        command: spawnCommand,
        args: spawnArguments,
        cwd: PACKAGE_ROOT,
        env: {
          ...envWithoutSmoke,
          SIDEKICKS_GC_PROBE: "1",
          // No focus steal on the operator's machine; see `src/main/window-reveal.ts`.
          [UNOBTRUSIVE_WINDOWS_ENV]: "1",
        },
      },
      removeProfileDirectory,
    );

    const child = managed.child;

    let stdout = "";
    let stderr = "";
    let probe: GcProbe | null = null;
    let pending = "";

    const spawnDeadline = setTimeout(() => {
      // SIGTERM first so the shim forwards it and Electron closes the inherited
      // stdout write end this promise's `close` is waiting on; SIGKILL to the
      // whole group after the grace, because a hung Electron ignores the first
      // and a hung Electron is the only reason this fires.
      managed.terminateWithEscalation(TERMINATION_GRACE_MS);
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const probeTagIndex = line.indexOf(GC_PROBE_TAG);
        if (probeTagIndex < 0) continue;
        const payload = line.slice(probeTagIndex + GC_PROBE_TAG.length).trim();
        if (!payload.startsWith("{")) continue;
        try {
          probe = JSON.parse(payload) as GcProbe;
        } catch {
          // Tagged but malformed — keep scanning subsequent lines.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const cleanup = (): void => {
      // Releases the escalation timer and, on the ordinary `close` path, signals
      // NOTHING: by then the child is reaped and its pid — and the group it led
      // — are the operating system's to reissue, which is why disposal reads the
      // `close` `ManagedElectronChild` recorded rather than asking for a kill.
      // On the spawn-`error` path it is the only kill there is, and the pid it
      // would need does not exist, so the direct handle is what it reaches.
      managed.dispose();
      removeProfileDirectory();
    };

    child.on("error", (err: Error) => {
      clearTimeout(spawnDeadline);
      cleanup();
      resolve({
        probe: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        exitCode: null,
        signal: null,
        elapsedMs: Date.now() - startedAt,
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(spawnDeadline);
      cleanup();
      resolve({
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
