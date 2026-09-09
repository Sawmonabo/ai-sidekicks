// Which machine a hardware-dependent budget is allowed to GATE on.
//
// Not a test file — no `include` glob reaches it. `budgets.json`'s
// `measurementProtocol.hardwareDependent` says a frame-time or CPU reading gates
// "on the pinned CI runner class the desktop workflow names by label", and until
// this module existed that sentence was prose with no mechanism: every such row
// was `n/a`, so nothing had ever had to decide what "the pinned runner class"
// means in a running process.
//
// The shape is `test/console/screenshot/baseline-platform.ts`' and deliberately
// not a second invention: one module owns the pin, exposes a boolean and a
// one-sentence reason, and every file in the tier makes the same decision from it.
// It cannot be that module — that one resolves `server.platform` from
// `vitest/browser`, which a Node-environment tier does not have, and it answers a
// different question (which platform's committed images are comparable, not which
// machine's timings are).
//
// WHAT A ROW DOES OFF THE PINNED CLASS, AND WHY IT IS NOT A SKIP
//
// It runs and REPORTS. `apps/desktop/AGENTS.md` requires every console PR to run
// every tier whose subject is in-tree, and a hardware-dependent measurement whose
// subject is present is not absent — it is present and not comparable. Skipping it
// would stop exercising the instrument everywhere except one runner, which is how
// a measurement quietly stops working and nobody finds out until the one machine
// that runs it goes red for a reason nobody can reproduce.
//
// WHY THESE THREE VARIABLES
//
// GitHub sets no variable carrying the workflow's `runs-on` label, so the class is
// identified by what the runner does publish. `GITHUB_ACTIONS` distinguishes a
// hosted runner from a developer's machine — a self-hosted or local run sets none
// of these — and `RUNNER_OS` / `RUNNER_ARCH` pin the image family and the
// architecture, which are the two properties a timing actually depends on. A
// second Linux runner class added to the desktop job would land here as a second
// entry rather than as a widened boolean.

import process from "node:process";

/**
 * The runner class `.github/workflows/ci.yml` names for the desktop tiers.
 *
 * `ubuntu-latest` is the only entry in the tier-1 job's matrix, and the endurance
 * tier runs in that job's desktop step. Stated once so the name a reported run
 * prints and the name the guard tests are the same string.
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
 * Carried on the reported line rather than swallowed, so a passing run on a
 * developer's machine says out loud that the figure it printed gated nothing.
 */
export const RUNNER_CLASS_DESCRIPTION: string = isPinnedRunnerClass
  ? `the pinned ${PINNED_RUNNER_CLASS} runner class, so this reading gates`
  : `not the pinned ${PINNED_RUNNER_CLASS} runner class ` +
    `(GITHUB_ACTIONS=${process.env["GITHUB_ACTIONS"] ?? "unset"}, ` +
    `RUNNER_OS=${process.env["RUNNER_OS"] ?? "unset"}, ` +
    `RUNNER_ARCH=${process.env["RUNNER_ARCH"] ?? "unset"}), so this reading is reported and gates nothing`;
