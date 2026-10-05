// Explains a smoke spawn that produced no probe line: the environment readings taken under one
// bounded budget, and the failure classifier.

import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";

import { TEST_TIMEOUT_SLACK_MS } from "../electron/child/child.js";
import {
  localDisplaySocketPath,
  needsXvfb,
  resolvedDisplay,
  isXdpyinfoMissing,
} from "../display-readiness.js";
import type { SpawnResult } from "./harness.js";
import { SMOKE_PROBE_TAG } from "#shared/probe-tags.js";

/**
 * Longest a single at-deadline subprocess reading may run; healthy readings take under 100 ms, so
 * this is about 15 times that.
 */
const DIAGNOSTIC_PROBE_TIMEOUT_MS = 1_500;

/**
 * Wall bound for the whole at-deadline collection. One shared bound keeps the enclosing test
 * budget a sum of constants; two independent per-probe timeouts could outgrow it and let
 * vitest's generic timeout replace the dump.
 */
export const DIAGNOSTIC_BUDGET_MS = 3_000;

/**
 * Ceiling the stalled-boot control asserts the measured collection against. The budget bounds
 * the probes, but the parent still pays the kill and reap after a cap expires, so the ceiling
 * adds the same reserve the close-event bound uses.
 */
export const DIAGNOSTIC_COLLECTION_CEILING_MS: number =
  DIAGNOSTIC_BUDGET_MS + TEST_TIMEOUT_SLACK_MS;

/**
 * Takes the environment readings for a failure dump. `externalProbeDeadline` is an absolute
 * instant (or `null` to skip the two subprocess readings); the caller measures the collection
 * from the same clock, so the bound and its measurement cannot disagree. A reading with no
 * budget left is recorded as skipped, never dropped. The process tree goes first because it
 * disappears once the caller signals the child.
 */
export function captureDiagnostics(
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
    // The spawn leads its own process group, so `-g <pid>` is exactly this spawn's tree.
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
        `[${label}] process tree ` +
          `(pgid=${String(child.pid)}):\n${processTree.stdout ?? "<unavailable>"}`,
      );
    }
  }

  const display = resolvedDisplay();
  if (externalProbeDeadline !== null && display !== undefined && process.platform !== "win32") {
    if (isXdpyinfoMissing()) {
      // No `x11-utils` on the ubuntu-24.04 runner image, so read the display socket instead.
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

// Renders everything the harness learned about a spawn that produced no probe line, so the next
// failure is attributable from one read of the CI log.
function renderDiagnosticDump(result: SpawnResult): string {
  const breadcrumbs =
    result.readinessBreadcrumbs.length > 0
      ? result.readinessBreadcrumbs.join("\n")
      : "<none — the renderer never reached dom-ready or did-finish-load>";
  return (
    `--- readiness events observed ---\n${breadcrumbs}\n` +
    `--- environment ---\n${result.diagnostics.join("\n")}\n` +
    `--- tagged lines that did not parse ` +
    `---\n${result.malformedProbeLines.join("\n") || "<none>"}\n` +
    `--- stdout ---\n${result.stdout}\n` +
    `--- stderr ---\n${result.stderr}\n`
  );
}

/**
 * Names the readiness signal that never arrived when no probe line was parsed. Every marker
 * match reads `combinedOutput`, because `xvfb-run` merges the child's stderr into stdout.
 */
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
  // Before the breadcrumb arm: this failure happens after `did-finish-load`, so that arm would
  // wrongly blame a hung `executeJavaScript` round trip.
  if (result.combinedOutput.includes(`${SMOKE_PROBE_TAG} index fetch failed`)) {
    return (
      "the renderer loaded and the probe expression evaluated, but the main " +
      "process could not fetch `sidekicks-renderer://app/index.html` back " +
      "through its own handler to read the CSP header."
    );
  }
  // The document is up and the callback ran, so the missing piece is the `executeJavaScript`
  // round trip. Before the timeout arm, which would wrongly say `did-finish-load` never fired.
  if (result.readinessBreadcrumbs.some((event) => event.includes("did-finish-load"))) {
    return (
      "the renderer finished loading and the probe callback ran, but the " +
      "`executeJavaScript` round trip never resolved — so this is a hung probe " +
      "evaluation, NOT a renderer that failed to load. Readiness reached: " +
      `${result.readinessBreadcrumbs.join(", ")}.`
    );
  }
  // Keyed on the recorded deadline, not on `signal`: the electron shim catches SIGTERM and exits
  // with code 1, so a signal test would hand this case to the `exitCode === 1` arm.
  if (result.timedOut) {
    // Breadcrumbs split one timeout into distinguishable shapes: nothing reached, `dom-ready`
    // only, or `did-finish-load` with no probe line after it.
    const reached =
      result.readinessBreadcrumbs.length > 0
        ? `Readiness reached: ${result.readinessBreadcrumbs.join(", ")}.`
        : "No readiness event fired at all — the renderer never reached `dom-ready`.";
    // A signal means the direct child took it; an exit code means the shim forwarded SIGTERM.
    const disposition =
      result.signal !== null
        ? `terminated (${result.signal})`
        : `terminated (SIGTERM; the electron shim forwarded ` +
          `it and exited ${String(result.exitCode)})`;
    return (
      `the process was still running at the ${String(result.spawnBudgetMs)}ms deadline and was ` +
      `${disposition} — \`did-finish-load\` never fired. ${reached}`
    );
  }
  if (result.exitCode === 1) {
    return "`app.whenReady()` rejected — the main process failed during startup.";
  }
  if (result.exitCode === 0 && result.combinedOutput.trim() === "") {
    // Chromium's process singleton notifies the existing owner and exits 0 without logging.
    return (
      "the main process exited 0 having printed nothing at all — it never " +
      "reached the probe branch. This is the silent arm of the same lock loss " +
      "the branch above names: the process singleton notifies the existing " +
      "owner over its socket and exits without logging, so the profile is " +
      "being shared with another Electron."
    );
  }
  return (
    "the process exited without emitting the probe " +
    "line and without a recognized failure marker."
  );
}

/** Renders the "no probe line arrived" failure message. */
export function renderReadinessFailure(result: SpawnResult): string {
  return (
    `Desktop main process never became ready: ${diagnoseMissingProbe(result)}\n` +
    `No \`${SMOKE_PROBE_TAG}\` line arrived within ${String(result.spawnBudgetMs)}ms.\n` +
    `Exit code: ${String(result.exitCode)}, signal: ` +
    `${String(result.signal)}, elapsed: ${String(result.elapsedMs)}ms.\n` +
    renderDiagnosticDump(result)
  );
}
