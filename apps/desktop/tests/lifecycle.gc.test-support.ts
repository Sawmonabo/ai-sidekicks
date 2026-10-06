// The Electron spawn-and-probe harness for the window GC probe.
//
// Everything here gets a probe reading out of a real Electron process: isolating a profile,
// arranging the activation gates, spawning through the one owner, scanning the tagged line, and
// releasing what the spawn held. Whether a reading is acceptable is the suite's decision. It
// shares the bundle paths, spawner and spawn deadline with `helpers/smoke-probe/harness.ts`; the
// two probes read different things and carry different diagnostics.
//
// The GC probe in `src/main/probes/gc.ts` runs 20 cycles of two `gc()` calls, an 8 MB
// allocation, two more `gc()` calls, a 50 ms wait and a `v8.queryObjects(BaseWindow)` count. It
// records whether `window-all-closed` fired, prints one `[SIDEKICKS_GC_PROBE]` JSON line and
// calls `app.exit(0)`. Bare `gc()` is used because `gc(true)` is a minor scavenge in V8.
//
// The probe runs only when:
//   1. The bundle was built with `electron-vite build --mode=smoke`. A release bundle has the
//      probe tree-shaken out and the suite would time out.
//   2. The spawn environment has `SIDEKICKS_GC_PROBE=1` and not `SIDEKICKS_SMOKE_PROBE=1`; the
//      smoke branch is checked first in `src/main/index.ts`.
//   3. Electron starts with `--js-flags=--expose-gc`. Without it `globalThis.gc()` is unwired and
//      the reading carries `globalGcAvailable` false for the suite to gate on.
//
// On Linux CI one Xvfb serves the whole job with `$DISPLAY` exported (see
// `.github/workflows/ci.yml`), so `needsXvfb()` is false and the binary is spawned directly. The
// `xvfb-run -a` arm is the fallback for a contributor with no display server.

import process from "node:process";

import type { GcProbeReading } from "#main/probes/gc.js";
import { UNOBTRUSIVE_WINDOWS_ENV } from "#main/windows/reveal.js";
import { GC_PROBE_TAG } from "#shared/probe-tags.js";
import { spawnChildCleanedUpAtSettleTime } from "./helpers/electron/child/cleanup.js";
import { TEST_TIMEOUT_SLACK_MS } from "./helpers/electron/child/spawner.js";
import { ELECTRON_BIN, MAIN_ENTRY_PATH, PACKAGE_ROOT } from "./helpers/fixture/bundle.js";
import { needsXvfb } from "./helpers/display-readiness.js";
import { createLaunchProfile } from "./helpers/launch/profile.js";
import {
  ISOLATED_SERVICE_READY_TIMEOUT_MS,
  ISOLATED_SERVICE_START_CEILING_MS,
  startIsolatedService,
} from "./helpers/isolated-service.js";
import { TERMINATION_GRACE_MS } from "./helpers/electron/child/managed-child.js";
import { SPAWNED_TREE_HOST_QUERY_CEILING_MS } from "./helpers/process-tree/budget.js";
import { SPAWN_TIMEOUT_MS } from "./helpers/smoke-probe/harness.js";
import { TaggedJsonReadingScanner } from "./helpers/tagged-line-scanner.js";

/**
 * The enclosing vitest budget, derived from the phases it must contain: the isolated service's
 * start, the spawn's blocking host queries, the spawn budget, the SIGTERM-to-SIGKILL grace, then
 * the shared reserve. The queries lead because no spawn deadline contains them. The suite's own
 * deadline must fire first (see `TEST_TIMEOUT_SLACK_MS`): a vitest timeout tears the worker down
 * with its timers and leaves the Electron reparented to init. The settle-time kill and profile
 * removal keep the process and its directory bounded even if this arithmetic is wrong.
 */
export const GC_TEST_TIMEOUT_MS: number =
  ISOLATED_SERVICE_START_CEILING_MS +
  SPAWNED_TREE_HOST_QUERY_CEILING_MS +
  SPAWN_TIMEOUT_MS +
  TERMINATION_GRACE_MS +
  TEST_TIMEOUT_SLACK_MS;

/** What one spawn produced, reading or not, with the context to diagnose it. */
interface GcProbeSpawnResult {
  readonly probe: GcProbeReading | null;
  /** Tagged lines that did not parse, each with the parser's reason. */
  readonly malformedProbeLines: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
}

/**
 * Spawn Electron on the GC probe path and resolve with what it emitted.
 *
 * It resolves on every outcome (a missing reading, a spawn error, a deadline kill) because the
 * suite's diagnosis needs the stdout, stderr and exit code that explain which happened. The
 * private profile comes off disk after the child is gone, at the end of the test; a removal that
 * fails fails the test.
 */
export async function spawnElectronGcProbe(): Promise<GcProbeSpawnResult> {
  const startedAt = Date.now();

  // The launch plays no scenario, so main's supervisor looks for the service; it finds this one
  // and starts none of its own on the person's account.
  let serviceEnvironment: Readonly<Record<string, string>>;
  try {
    serviceEnvironment = (await startIsolatedService(ISOLATED_SERVICE_READY_TIMEOUT_MS))
      .environment;
  } catch (serviceFailure: unknown) {
    return {
      probe: null,
      malformedProbeLines: [],
      stdout: "",
      stderr: serviceFailure instanceof Error ? serviceFailure.message : String(serviceFailure),
      exitCode: null,
      signal: null,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // A private profile keeps this Electron off the default profile's `SingletonLock`: a second
  // instance sees `gotTheLock === false` and exits 0 before the probe runs.
  const profile = createLaunchProfile("sidekicks-gc-test-");

  // `--js-flags=--expose-gc` must precede the entry script so Electron forwards it to V8; the
  // suite asserts `globalGcAvailable` to fail loudly without it.
  const electronArgs = [
    "--js-flags=--expose-gc",
    `--user-data-dir=${profile.directory}`,
    MAIN_ENTRY_PATH,
  ];
  const spawnCommand = needsXvfb() ? "xvfb-run" : ELECTRON_BIN;
  const spawnArguments = needsXvfb() ? ["-a", ELECTRON_BIN, ...electronArgs] : electronArgs;

  // Strip SIDEKICKS_SMOKE_PROBE so the smoke branch, checked first in the main entrypoint,
  // cannot fire ahead of the GC probe.
  const { SIDEKICKS_SMOKE_PROBE: _smokeProbeSwitch, ...envWithoutSmoke } = process.env;

  return new Promise<GcProbeSpawnResult>((resolve) => {
    // The shared owner kills the whole process group at the end of the test, whatever its
    // outcome, then removes the profile.
    const managed = spawnChildCleanedUpAtSettleTime(
      {
        command: spawnCommand,
        args: spawnArguments,
        cwd: PACKAGE_ROOT,
        env: {
          ...envWithoutSmoke,
          ...serviceEnvironment,
          SIDEKICKS_GC_PROBE: "1",
          // No focus steal on the person's machine; see `src/main/windows/reveal.ts`.
          [UNOBTRUSIVE_WINDOWS_ENV]: "1",
        },
      },
      profile.remove,
    );

    const child = managed.child;

    let stdout = "";
    let stderr = "";
    const probeLines = new TaggedJsonReadingScanner<GcProbeReading>(GC_PROBE_TAG);

    const spawnDeadline = setTimeout(() => {
      // SIGTERM first so the shim forwards it and Electron closes the stdout write end `close`
      // waits on; SIGKILL to the whole group after the grace.
      managed.terminateWithEscalation(TERMINATION_GRACE_MS);
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      // Output proves the tree is up, so record its descendants now: a rootless kill needs them
      // once the shim is reaped (`spawned-tree-record.ts` says why the root's `exit` is too late).
      managed.captureTreeDescendants();
      const text = chunk.toString("utf8");
      stdout += text;
      probeLines.push(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const settle = (
      result: Omit<GcProbeSpawnResult, "probe" | "malformedProbeLines" | "elapsedMs">,
    ): void => {
      clearTimeout(spawnDeadline);
      // Releases the escalation timer. On the ordinary `close` path it signals nothing, since the
      // pid and its group are the OS's to reissue by then. On a spawn `error` it is the only kill,
      // aimed at the direct handle.
      managed.dispose();
      resolve({
        ...result,
        probe: probeLines.reading,
        malformedProbeLines: probeLines.malformedLines,
        elapsedMs: Date.now() - startedAt,
      });
    };

    child.on("error", (err: Error) => {
      settle({
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        exitCode: null,
        signal: null,
      });
    });

    child.on("close", (exitCode, signal) => {
      settle({ stdout, stderr, exitCode, signal });
    });
  });
}
