// The Electron spawn-and-probe harness for the BrowserWindow GC probe.
//
// Everything here gets a probe reading out of a real Electron process: isolating a profile,
// arranging the activation gates, spawning through the one owner, scanning the tagged line, and
// releasing what the spawn held. Whether a reading is acceptable is the suite's decision. It is a
// sibling of `smoke-probe-harness.ts` and shares its bundle paths and spawner; the two probes read
// different things and carry different diagnostics. The harness asserts nothing, so a probe
// failure has one origin.
//
// The GC probe in `src/main/probes/gc-probe.ts` runs 20 cycles of two `gc()` calls, an 8 MB
// allocation, two more `gc()` calls, a 50 ms wait and a `v8.queryObjects(BrowserWindow)` count. It
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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import type { GcProbeReading } from "@main/probes/gc-probe.js";
import { UNOBTRUSIVE_WINDOWS_ENV } from "@main/windows/window-reveal.js";
import { GC_PROBE_TAG } from "@shared/probe-tags.js";
import { spawnChildCleanedUpAtSettleTime } from "./electron-child-cleanup.js";
import { TEST_TIMEOUT_SLACK_MS } from "./electron-child.js";
import { ELECTRON_BIN, MAIN_ENTRY, PACKAGE_ROOT } from "./smoke-probe-harness.js";
import { needsXvfb } from "./display-readiness.js";
import { TERMINATION_GRACE_MS } from "./managed-electron-child.js";
import { SPAWNED_TREE_HOST_QUERY_CEILING_MS } from "./process-tree/budget.js";

/**
 * The spawn deadline: 20 cycles of about 150 ms plus Electron boot (1-2 s on Linux runners),
 * with a generous backstop.
 */
export const SPAWN_TIMEOUT_MS = 30_000;

/**
 * The enclosing vitest budget, derived from the phases it must contain: the spawn's blocking host
 * queries, the spawn budget, the SIGTERM-to-SIGKILL grace, then the shared reserve. The queries
 * lead because no spawn deadline contains them. The suite's own deadline must fire first (see
 * `TEST_TIMEOUT_SLACK_MS`): a vitest timeout tears the worker down with its timers and leaves
 * the Electron reparented to init. The settle-time kill and profile removal keep the process and
 * its directory bounded even if this arithmetic is wrong.
 */
export const GC_TEST_TIMEOUT_MS: number =
  SPAWNED_TREE_HOST_QUERY_CEILING_MS +
  SPAWN_TIMEOUT_MS +
  TERMINATION_GRACE_MS +
  TEST_TIMEOUT_SLACK_MS;

/** What one spawn produced, reading or not, with the context to diagnose it. */
interface GcProbeSpawnResult {
  readonly probe: GcProbeReading | null;
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
 * suite's diagnosis needs the stdout, stderr and exit code that explain which happened.
 */
export function spawnElectronGcProbe(): Promise<GcProbeSpawnResult> {
  const startedAt = Date.now();

  // A per-spawn userData dir keeps this Electron off the default profile's `SingletonLock`: a
  // second instance sees `gotTheLock === false` and exits 0 before the probe runs.
  // `removeProfileDirectory` below takes it off disk from both paths that can reach it.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sidekicks-gc-test-"));

  // The one remover of this spawn's profile, called from the close and error path and from the
  // settle-time disposer; `force: true` lets both run. Best-effort, since a leftover temporary
  // profile must not replace the result the reader came for.
  const removeProfileDirectory = (): void => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort; see above.
    }
  };

  // `--js-flags=--expose-gc` must precede the entry script so Electron forwards it to V8; the
  // suite asserts `globalGcAvailable` to fail loudly without it.
  const electronArgs = ["--js-flags=--expose-gc", `--user-data-dir=${userDataDir}`, MAIN_ENTRY];
  const spawnCommand = needsXvfb() ? "xvfb-run" : ELECTRON_BIN;
  const spawnArguments = needsXvfb() ? ["-a", ELECTRON_BIN, ...electronArgs] : electronArgs;

  // Strip SIDEKICKS_SMOKE_PROBE so the smoke branch, checked first in the main entrypoint,
  // cannot fire ahead of the GC probe.
  const { SIDEKICKS_SMOKE_PROBE: _smokeProbeSwitch, ...envWithoutSmoke } = process.env;

  return new Promise<GcProbeSpawnResult>((resolve) => {
    // The shared owner makes the spawn survivable: the child leads its own process group, so the
    // kill reaches the browser behind the `node_modules/.bin/electron` shim (SIGKILL cannot be
    // forwarded), and the kill runs on `onTestFinished`, so it covers every outcome. The same call
    // binds profile removal to the test after the kill, covering a vitest timeout, which runs
    // neither `close` nor `error`.
    const managed = spawnChildCleanedUpAtSettleTime(
      {
        command: spawnCommand,
        args: spawnArguments,
        cwd: PACKAGE_ROOT,
        env: {
          ...envWithoutSmoke,
          SIDEKICKS_GC_PROBE: "1",
          // No focus steal on the person's machine; see `src/main/windows/window-reveal.ts`.
          [UNOBTRUSIVE_WINDOWS_ENV]: "1",
        },
      },
      removeProfileDirectory,
    );

    const child = managed.child;

    let stdout = "";
    let stderr = "";
    let probe: GcProbeReading | null = null;
    let pending = "";

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
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const probeTagIndex = line.indexOf(GC_PROBE_TAG);
        if (probeTagIndex < 0) continue;
        const payload = line.slice(probeTagIndex + GC_PROBE_TAG.length).trim();
        if (!payload.startsWith("{")) continue;
        try {
          probe = JSON.parse(payload) as GcProbeReading;
        } catch {
          // Tagged but malformed; keep scanning.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const cleanup = (): void => {
      // Releases the escalation timer. On the ordinary `close` path it signals nothing, since the
      // pid and its group are the OS's to reissue by then. On a spawn `error` it is the only kill,
      // aimed at the direct handle.
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
