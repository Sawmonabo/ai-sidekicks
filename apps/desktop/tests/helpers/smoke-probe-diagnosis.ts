// Reading a smoke spawn's output and explaining a spawn that produced no probe line.
//
// The tagged lines the main-process smoke branch emits, the scanner that reads the
// readiness breadcrumbs out of them, the environment readings taken at spawn and at the
// deadline under one bounded budget, and the classification that names which readiness
// signal never arrived. A failure here has to be legible from outside the process it
// describes, so every reading ends up in the dump.

import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";

import { TEST_TIMEOUT_SLACK_MS } from "./electron-child.js";
import {
  localDisplaySocketPath,
  needsXvfb,
  resolvedDisplay,
  xdpyinfoMissing,
} from "./display-readiness.js";
import type { SpawnResult } from "./smoke-probe-harness.js";
import { READINESS_BREADCRUMB_TAG, SMOKE_PROBE_TAG } from "@shared/probe-tags.js";

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
  return "the process exited without emitting the probe line and without a recognized failure marker.";
}

// The single renderer for "no probe line arrived". Both the assertion path and
// the negative control below go through this function, so the control proves
// what the real failure would print rather than a re-implementation of it.
export function renderReadinessFailure(result: SpawnResult): string {
  return (
    `Desktop main process never became ready: ${diagnoseMissingProbe(result)}\n` +
    `No \`${SMOKE_PROBE_TAG}\` line arrived within ${String(result.spawnBudgetMs)}ms.\n` +
    `Exit code: ${String(result.exitCode)}, signal: ${String(result.signal)}, elapsed: ${String(result.elapsedMs)}ms.\n` +
    renderDiagnosticDump(result)
  );
}
