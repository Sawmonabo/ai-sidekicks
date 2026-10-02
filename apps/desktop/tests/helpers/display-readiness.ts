// Whether an X display is there for Electron to open a window on.
//
// Every Electron-launching harness spawns through this: which display the child gets, whether the
// spawn is wrapped in `xvfb-run`, and a readiness gate that refuses a spawn against a display that
// is configured but not serving, so the failure is named instead of a spawn-budget silence.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * How long to wait for the X display named by `$DISPLAY` to start answering before refusing to
 * spawn.
 *
 * CI's job-level Xvfb step already gates on readiness; this makes a configured but dead display an
 * immediate, named refusal instead of a full spawn-budget silence.
 */
export const DISPLAY_READY_TIMEOUT_MS = 10_000;
const DISPLAY_POLL_INTERVAL_MS = 250;

/** Resolves the X display this spawn should use. */
export function resolvedDisplay(): string | undefined {
  return process.env["DISPLAY"];
}

/** Whether the spawn must be wrapped in `xvfb-run`: on Linux with no display configured. */
export function needsXvfb(): boolean {
  // CI exports `$DISPLAY` from one job-level Xvfb, so this is false there and the spawn is direct.
  // The `xvfb-run` fallback remains for a Linux contributor with no display server. It is not
  // CI's path: `xvfb-run -a` picks its display number with a racy lock-file scan that two
  // concurrent invocations can lose together, costs a second X server and shell per spawn, and
  // merges the child's stderr into stdout (see `SpawnResult.combinedOutput`).
  return process.platform === "linux" && !resolvedDisplay();
}

let xdpyinfoProbe: boolean | undefined;

/**
 * Whether `xdpyinfo` is absent. Probed on first use, not at import, so a run that never checks a
 * display spawns nothing; the answer is kept because it cannot change mid-run.
 */
export function isXdpyinfoMissing(): boolean {
  xdpyinfoProbe ??= spawnSync("xdpyinfo", ["-version"], { stdio: "ignore" }).error !== undefined;
  return xdpyinfoProbe;
}

/**
 * The unix socket path of a local `:N` display, or `null` for a remote or path-style `$DISPLAY`
 * (an XQuartz launchd socket, `host:0` over TCP), which the readiness gate declines to guess about.
 */
export function localDisplaySocketPath(display: string): string | null {
  const localDisplay = /^:(\d+)(\.\d+)?$/.exec(display);
  return localDisplay === null ? null : `/tmp/.X11-unix/X${localDisplay[1]}`;
}

// Does the named X display actually answer? `xdpyinfo` is a real client handshake, which a socket
// that exists but is not serving fails exactly as Electron would. Without it (the ubuntu-24.04
// runner image ships `xvfb` but not `x11-utils`) the display's unix socket is checked: weaker,
// since a crashed server can leave a stale socket, but decisive for a `$DISPLAY` whose server
// never started. A display that cannot be probed either way reports ready, so the gate never
// refuses a spawn it has no evidence against.
function displayAnswers(display: string): boolean {
  if (!isXdpyinfoMissing()) {
    const probe = spawnSync("xdpyinfo", ["-display", display], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return probe.error === undefined && probe.status === 0;
  }
  const socketPath = localDisplaySocketPath(display);
  return socketPath === null ? true : existsSync(socketPath);
}

/**
 * Blocks until the display answers or the budget expires. Returns null when ready, or a
 * human-readable reason when not.
 */
export function awaitDisplayReady(display: string): string | null {
  const budgetMs = DISPLAY_READY_TIMEOUT_MS;
  const probeDescription = isXdpyinfoMissing()
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
    // Synchronous on purpose: this runs before the child exists, so there is nothing to service on
    // the event loop.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DISPLAY_POLL_INTERVAL_MS);
  }
}
