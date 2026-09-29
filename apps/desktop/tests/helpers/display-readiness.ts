// Whether an X display is there for Electron to open a window on.
//
// Every Electron-launching harness spawns through this: which display the child gets,
// whether the spawn has to be wrapped in `xvfb-run`, and a readiness gate that refuses a
// spawn against a display that is configured but not serving, so the failure is named
// rather than a spawn-budget silence.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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

// Resolves the X display this spawn should use, honoring the test-only
// override that drives the negative control.
export function resolvedDisplay(): string | undefined {
  return process.env[FORCED_DISPLAY_ENV] ?? process.env["DISPLAY"];
}

export function needsXvfb(): boolean {
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

// Resolved once: probing for the tool on every poll would spawn a process per
// iteration to answer a question whose answer cannot change mid-run.
export const xdpyinfoMissing: boolean =
  spawnSync("xdpyinfo", ["-version"], { stdio: "ignore" }).error !== undefined;

// Local `:N` displays expose a unix socket at a well-known path. A remote or
// path-style `$DISPLAY` (an XQuartz launchd socket, `host:0` over TCP) does
// not, which is why the readiness gate declines rather than guesses for those.
export function localDisplaySocketPath(display: string): string | null {
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
export function awaitDisplayReady(display: string): string | null {
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
