// Spawns a real Electron process on a private profile and reads its tagged probe lines.
// The harness asserts nothing: the suite decides whether a reading is acceptable, and
// `smoke-probe-diagnosis.ts` explains a missing one. `src/main/probes/smoke-probe.ts` emits the
// lines.

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

/** Package root (`apps/desktop/`); the sibling GC harness spawns with it as `cwd` too. */
export const PACKAGE_ROOT: string = path.resolve(__dirname, "../..");

/** The `electron-vite build` main entry the spawn loads. */
export const MAIN_ENTRY: string = path.join(PACKAGE_ROOT, "out/main/index.js");

/** The `electron-vite build` preload entry. */
export const PRELOAD_ENTRY: string = path.join(PACKAGE_ROOT, "out/preload/index.cjs");

/** Absolute path to the `electron` launcher shim, so the spawn does not depend on `$PATH`. */
export const ELECTRON_BIN: string = path.join(PACKAGE_ROOT, "node_modules/.bin/electron");

/**
 * Where the Electron binary lives, as distinct from the launcher shim. Electron 44 downloads its
 * binary lazily, so `pnpm install` alone leaves no `dist/`; `scripts/materialize-electron.ts`
 * fetches it at install time, and the pre-spawn presence check turns a skipped step into a named
 * refusal instead of a spawn-deadline timeout. Presence is all this suite needs, so a stale
 * binary is fine.
 */
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

/** The in-app window budget (5 s); the spawn deadline below is only a backstop around it. */
export const WINDOW_BUDGET_MS = 5_000;

/**
 * Spawn-side backstop that kills a stuck Electron rather than hanging the suite. The
 * `WINDOW_BUDGET_MS` assertion stays the load-bearing timing check.
 *
 * Measured boot-and-probe times: 462-510 ms on an unloaded macOS M1 Pro, and 4129 / 6732 /
 * 13008 ms on three runs on a 4-vCPU hosted Linux runner. The local figure does not transfer, so
 * the ceiling is 30 s (about 2.3x the worst hosted run) and is not tightened on three samples.
 */
export const SPAWN_TIMEOUT_MS = 30_000;

/**
 * The enclosing vitest budget, derived from the phases it contains: the display gate, the
 * spawned tree's host queries, the spawn deadline, the diagnostic collection ceiling, the
 * SIGTERM to SIGKILL grace, and slack. A phase left out lets vitest's generic timeout win over
 * the harness's own report.
 */
export const BOOT_TEST_TIMEOUT_MS: number =
  DISPLAY_READY_TIMEOUT_MS +
  SPAWNED_TREE_HOST_QUERY_CEILING_MS +
  SPAWN_TIMEOUT_MS +
  DIAGNOSTIC_COLLECTION_CEILING_MS +
  TERMINATION_GRACE_MS +
  TEST_TIMEOUT_SLACK_MS;

/**
 * Test-only override that makes the spawn deadline fire almost immediately. It also withholds
 * `SIDEKICKS_SMOKE_PROBE`, so the app boots and never emits a probe line: a real stall.
 */
export const FORCED_STALL_ENV = "SIDEKICKS_SMOKE_FORCE_SPAWN_STALL";
/** Spawn deadline under the forced-stall override. */
export const FORCED_STALL_SPAWN_TIMEOUT_MS = 2_000;

/** The enclosing budget under the override: the boot budget with the shortened spawn term. */
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
    // Origin readings taken against the real bundle served over the privileged scheme.
    readonly protocol: string;
    readonly host: string;
    readonly indexedDB: string;
    readonly localStorageRoundTrip: boolean;
    readonly rootChildren: number;
  };
  // Read by the main process: `net.fetch` of the served `index.html`, so the header is observed
  // on the wire.
  readonly contentSecurityPolicy: string | null;
}

/** What a spawn produced: the parsed probe, the captured streams, and the timing readings. */
export interface SpawnResult {
  readonly probe: SmokeProbe | null;
  readonly stdout: string;
  readonly stderr: string;
  // stdout and stderr in arrival order. `xvfb-run` merges the child's stderr into stdout, so
  // diagnosis keys off this field to work under either stream topology.
  readonly combinedOutput: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
  // Ordered `dom-ready` / `ready-to-show` breadcrumbs from the child's output. Empty means the
  // renderer never reached even the first.
  readonly readinessBreadcrumbs: readonly string[];
  // Environment readings taken at spawn and at the deadline.
  readonly diagnostics: readonly string[];
  // The spawn budget this spawn ran under, which the forced-stall override changes.
  readonly spawnBudgetMs: number;
  // Whether this harness's deadline fired. Not inferred from `signal`: the electron shim catches
  // SIGTERM, forwards it, and exits with code 1 and no signal of its own.
  readonly timedOut: boolean;
  // Wall time the at-deadline collection spent, or null if the deadline never fired.
  readonly diagnosticCollectionMs: number | null;
  // The `$DISPLAY` the child was given, or undefined when none was set.
  readonly childDisplay: string | undefined;
}

// Chromium switches for the headless-Linux path only. None weakens the renderer sandbox (CI
// forbids `--no-sandbox`); the three-globals assertions would fail if one did.
//   --disable-gpu            composite in software; a hosted runner has no GPU to initialize
//   --disable-dev-shm-usage  put shared memory under /tmp instead of a possibly small /dev/shm
//   --password-store=basic   skip the keyring probe over D-Bus on a box with no session bus
const LINUX_HEADLESS_CHROMIUM_SWITCHES: readonly string[] = [
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--password-store=basic",
];

/**
 * Spawns Electron on a private profile and resolves with everything it produced. It never
 * rejects: a refused or failed spawn resolves with a null probe and the reason in the output.
 */
export function spawnElectron(): Promise<SpawnResult> {
  const startedAt = Date.now();

  // The forced-stall override shortens the spawn deadline and withholds the probe opt-in; the
  // deadline, collection, termination and failure renderer stay the production ones.
  const forcedStall = process.env[FORCED_STALL_ENV] !== undefined;
  const spawnBudgetMs = forcedStall ? FORCED_STALL_SPAWN_TIMEOUT_MS : SPAWN_TIMEOUT_MS;

  // An inherited probe opt-in would defeat the forced stall.
  const { SIDEKICKS_SMOKE_PROBE: _inheritedProbeOptIn, ...envWithoutProbe } = process.env;
  const spawnBaseEnv = forcedStall ? envWithoutProbe : process.env;

  // Resolved once so the display the harness gated on is the one the child receives.
  const childDisplay = resolvedDisplay();

  // A private profile makes Electron's `SingletonLock` per-spawn. On the default profile a second
  // Electron on the machine holds the lock, and the loser quits before any window exists and exits
  // 0 with no output, which looks like a failed boot.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sidekicks-smoke-test-"));

  // The one remover of this spawn's profile, shared by the refusal, settlement and settle-time
  // paths; `force` makes it idempotent. A leftover temporary profile must not replace the result.
  const removeProfileDirectory = (): void => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // A leftover temporary directory must not replace the run's result.
    }
  };

  // Refuse before spawning when the named display is not serving, instead of discovering it as a
  // spawn-deadline silence. The negative control drives this path.
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

  // `xvfb-run -a` picks an unused display number; it is the local fallback when no display is
  // set. Chromium switches must precede the entry script so Electron routes them to the browser
  // process.
  const electronArgs = [
    ...(process.platform === "linux" ? LINUX_HEADLESS_CHROMIUM_SWITCHES : []),
    `--user-data-dir=${userDataDir}`,
    MAIN_ENTRY,
  ];
  const spawnCommand = needsXvfb() ? "xvfb-run" : ELECTRON_BIN;
  const spawnArguments = needsXvfb() ? ["-a", ELECTRON_BIN, ...electronArgs] : electronArgs;

  return new Promise<SpawnResult>((resolve) => {
    // The shared owner binds the child's lifetime to this test, not to the timers below, so a
    // pass, an assertion failure and vitest's own timeout all kill it. The same call binds the
    // profile removal to the test.
    const managed = spawnChildCleanedUpAtSettleTime(
      {
        command: spawnCommand,
        args: spawnArguments,
        cwd: PACKAGE_ROOT,
        env: {
          // Dropped under the forced stall so an exported `SIDEKICKS_SMOKE_PROBE=1` cannot make the
          // app emit a probe line and quietly stop the control testing a stall.
          ...spawnBaseEnv,
          // Pinned so a regressed readiness gate cannot let the child open on the developer's
          // real display and pass.
          ...(childDisplay === undefined ? {} : { DISPLAY: childDisplay }),
          // Opt-in for the main-process smoke branch, which the compile-time smoke build flag
          // removes from release bundles. Withheld under the forced stall.
          ...(forcedStall ? {} : { SIDEKICKS_SMOKE_PROBE: "1" }),
          // Emit the `dom-ready` / `ready-to-show` breadcrumbs beside `did-finish-load`.
          SIDEKICKS_SMOKE_TRACE_READINESS: "1",
          // Reveal the window without activating the app (smoke build only; see
          // `src/main/windows/window-reveal.ts`).
          [UNOBTRUSIVE_WINDOWS_ENV]: "1",
          // A session-bus address that fails fast: with it unset, libdbus tries an X11 autolaunch
          // on a runner that has no bus. Pairs with `--password-store=basic`.
          ...(process.platform === "linux"
            ? { DBUS_SESSION_BUS_ADDRESS: "disabled:", NO_AT_BRIDGE: "1" }
            : {}),
        },
      },
      removeProfileDirectory,
    );

    // Every kill goes through `managed`, which owns the process group the detached spawn created.
    const child = managed.child;

    let stdout = "";
    let stderr = "";
    let combinedOutput = "";
    let probe: SmokeProbe | null = null;
    const readinessBreadcrumbs: string[] = [];
    const diagnostics: string[] = captureDiagnostics("at-spawn", child, null);
    // Carries the unfinished trailing piece of stdout between chunks, so a probe line split
    // across two chunks still matches.
    let pending = "";
    let deadlineFired = false;
    let collectionMs: number | null = null;

    const spawnDeadline = setTimeout(() => {
      // Backstop: the in-app window budget is the load-bearing assertion. Signals go to the
      // process group, SIGTERM then SIGKILL: SIGKILL is unforwardable, so a shim-only kill would
      // orphan the browser process holding the stdout pipe and `close` would never fire. The
      // environment is captured first because `ps` has nothing to report once the tree is gone.
      deadlineFired = true;
      // The collection is timed and recorded, so the stalled-boot test asserts on its own cost
      // rather than on total wall time, which Electron's teardown dominates.
      const collectionStartedAt = Date.now();
      const atDeadline = captureDiagnostics(
        "at-deadline",
        child,
        // Same instant the measurement starts from, so the bound and its measurement share a clock.
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

    // Settles once: clears the deadline, releases the escalation timer and removes the profile.
    // The settle-time registration above covers outcomes where no terminal event arrives.
    const settle = (result: SpawnResult): void => {
      clearTimeout(spawnDeadline);
      // On the ordinary `close` path this signals nothing: the child is reaped and its pid, and
      // its group, belong to the operating system again.
      managed.dispose();
      removeProfileDirectory();
      resolve(result);
    };

    // Breadcrumbs go to stderr, which the `xvfb-run` fallback merges into stdout, so scan both.
    // One scanner per stream; see `ReadinessLineScanner`.
    // shared.
    const stdoutReadiness = new ReadinessLineScanner();
    const stderrReadiness = new ReadinessLineScanner();

    child.stdout.on("data", (chunk: Buffer) => {
      // Output is the evidence the tree is up; record its descendants now, because the root's own
      // `exit` is too late (see `spawned-tree-record.ts`).
      managed.captureTreeDescendants();
      const text = chunk.toString("utf8");
      stdout += text;
      combinedOutput += text;
      readinessBreadcrumbs.push(...stdoutReadiness.push(text));
      // Split on newlines and carry the unterminated suffix to the next chunk.
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      // The tag is unique, so a substring match suffices; the payload after it is JSON.
      for (const line of lines) {
        const probeTagIndex = line.indexOf(SMOKE_PROBE_TAG);
        if (probeTagIndex < 0) continue;
        const payload = line.slice(probeTagIndex + SMOKE_PROBE_TAG.length).trim();
        if (!payload.startsWith("{")) continue;
        try {
          probe = JSON.parse(payload) as SmokeProbe;
        } catch {
          // Tagged but malformed: keep scanning, so a partial chunk cannot mask a later valid line.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      combinedOutput += text;
      readinessBreadcrumbs.push(...stderrReadiness.push(text));
    });

    // A failed launch (for example `xvfb-run` missing from PATH) arrives as an `error` event, not
    // a throw. Settle it so the null-probe path reports the reason instead of crashing vitest.
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
