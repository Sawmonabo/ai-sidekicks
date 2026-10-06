// Which machine a hardware-dependent budget may gate on. Not a test file: no `include` glob
// reaches it.
//
// `tests/budget/document.json`'s `measurementProtocol.hardwareDependent` says a frame-time or CPU
// reading gates "on the pinned CI runner class the desktop workflow names by label". One module
// owns that pin, exposes a boolean and a one-sentence reason, and every file in the tier decides
// from it.
//
// Off the pinned class a row runs and reports rather than skips: every PR runs every tier whose
// subject is in-tree, and skipping would stop exercising the instrument everywhere but one
// runner, so it could quietly stop working.
//
// GitHub sets no variable carrying the workflow's `runs-on` label, so the class is identified
// by what the runner publishes. `GITHUB_ACTIONS` separates a hosted runner from a developer's
// machine, and `RUNNER_OS` / `RUNNER_ARCH` pin the two properties a timing depends on.

import process from "node:process";

/**
 * The runner class `.github/workflows/ci.yml` names for the desktop tiers.
 *
 * `ubuntu-latest` is the `desktop` job's runner, and the endurance tier runs in that job.
 */
const PINNED_RUNNER_CLASS = "ubuntu-latest";

const PINNED_RUNNER_OPERATING_SYSTEM = "Linux";
const PINNED_RUNNER_ARCHITECTURE = "X64";

/** Whether this process is running on the class a timing may be gated against. */
export const isPinnedRunnerClass: boolean =
  process.env["GITHUB_ACTIONS"] === "true" &&
  process.env["RUNNER_OS"] === PINNED_RUNNER_OPERATING_SYSTEM &&
  process.env["RUNNER_ARCH"] === PINNED_RUNNER_ARCHITECTURE;

/**
 * What this host is, said the way a reader of a green run needs to hear it.
 *
 * Printed on the reported line so a pass on a developer's machine says the figure gated nothing.
 */
export const RUNNER_CLASS_DESCRIPTION: string = isPinnedRunnerClass
  ? `the pinned ${PINNED_RUNNER_CLASS} runner class, so this reading gates`
  : `not the pinned ${PINNED_RUNNER_CLASS} runner class ` +
    `(GITHUB_ACTIONS=${process.env["GITHUB_ACTIONS"] ?? "unset"}, ` +
    `RUNNER_OS=${process.env["RUNNER_OS"] ?? "unset"}, ` +
    `RUNNER_ARCH=${process.env["RUNNER_ARCH"] ?? "unset"}` +
    `), so this reading is reported and gates nothing`;
