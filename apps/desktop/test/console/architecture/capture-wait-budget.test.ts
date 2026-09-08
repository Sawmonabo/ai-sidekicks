// The screenshot tier waits long enough to spend the wait it hands its own captures.
//
// WHAT A BOUND OUTLIVING ITS BUDGET COSTS. `settled-capture.ts` sizes each capture's
// stability wait to the window it had to open — two captures of the held box compared
// against each other, both linear in that box's pixels — so a surface several windows
// tall is given several times the per-window wait. That wait is spent INSIDE Vitest's
// own per-test timeout, and Vitest resolves that to 15 000 ms under browser mode. A
// capture at the window ceiling is given 20 000 ms, so under the inherited figure the
// enclosing timeout fires first and reports "Test timed out", which names neither the
// wait nor the surface — the exact inversion `test/console/launch-deadline.ts` records
// for the Electron tiers, reaching this tier by a different route.
//
// SO THE CLAIM IS HELD AGAINST THE CONFIG THE RUNNER RESOLVES, not against a number
// read out of it: `vitest-projects.ts` constructs the real `TestProject` instances, and
// what is compared is the patience those projects actually carry against the wait the
// shipped rule actually derives. A literal re-planted on the tier fails here with the
// two figures rather than surfacing months later as one timed-out capture.
//
// The tier is found by asking which projects CLAIM the screenshot files, the way
// `launch-deadline.test.ts` finds the launching tiers. A browser-mode project resolves
// under a name its config never wrote — `console-screenshot (chromium)`, the instance
// appended — so a lookup by the declared name finds nothing and every case after it
// passes over `undefined`.

import { globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LONGEST_CAPTURE_STABILITY_WAIT_MS,
  SCREENSHOT_TIER_TIMEOUT_MS,
} from "../../../vitest/screenshot-pins.js";
import { STABILITY_WAIT_PER_VIEWPORT_MS } from "../screenshot/capture-viewport.js";
import { resolveVitestProjects, type ResolvedVitestProjects } from "../vitest-projects.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");

/** Every test file that takes a capture, which is what makes a project this tier. */
const SCREENSHOT_TIER_FILE_GLOB = "test/console/screenshot/**/*.test.{ts,tsx}";

/** What the resolution costs, which is a config load rather than a run. */
const PROJECT_RESOLUTION_ALLOWANCE_MS = 60_000;

describe("the screenshot tier's patience against the wait it hands out", () => {
  let resolvedProjects: ResolvedVitestProjects;
  let capturingTierNames: readonly string[];
  let capturingTiers: readonly { name: string; testTimeoutMs: number; hookTimeoutMs: number }[];

  beforeAll(async () => {
    resolvedProjects = await resolveVitestProjects();
    const screenshotFiles = globSync(SCREENSHOT_TIER_FILE_GLOB, { cwd: PACKAGE_ROOT }).sort();
    const owners = resolvedProjects.projects.filter((project) =>
      screenshotFiles.some((relativePath) =>
        project.matchesTestGlob(join(PACKAGE_ROOT, relativePath)),
      ),
    );
    capturingTierNames = owners.map((project) => project.name);
    capturingTiers = owners.map((project) => ({
      name: project.name,
      testTimeoutMs: project.config.testTimeout,
      hookTimeoutMs: project.config.hookTimeout,
    }));
  }, PROJECT_RESOLUTION_ALLOWANCE_MS);

  afterAll(async () => {
    await resolvedProjects.close();
  });

  it("finds a capturing tier, and does not find every tier", () => {
    // Both halves are load-bearing. Without the first, the per-tier cases below are
    // vacuously true over an empty list — the shape a config that failed to resolve,
    // or a glob that matched nothing, would take. Without the second they would also
    // pass over a `matchesTestGlob` that claimed everything: this very file belongs to
    // `console-architecture`, which takes no capture.
    expect(capturingTierNames.length).toBeGreaterThan(0);
    expect(capturingTierNames).not.toContain("console-architecture");
  });

  it("carries the derived patience in every capturing tier's test and hook budgets", () => {
    // Both budgets, on `launch-deadline.test.ts`'s reasoning: a capture taken from a
    // hook is bounded by the other figure, and a guarantee that holds for one of them
    // is not a guarantee. Equality rather than "at least", so a literal that happens to
    // be large enough still fails — it is a number nobody re-derives when a bound moves.
    const underived = capturingTiers.filter(
      (tier) =>
        tier.testTimeoutMs !== SCREENSHOT_TIER_TIMEOUT_MS ||
        tier.hookTimeoutMs !== SCREENSHOT_TIER_TIMEOUT_MS,
    );
    expect(underived).toStrictEqual([]);
  });

  it("leaves room for the longest wait a capture can be given", () => {
    // THE GUARANTEE. Strictly greater rather than at least: equality is the case where
    // the two timers race, and the one that must win is the matcher's, because its
    // failure names the wait and the reference while Vitest's names neither.
    expect(SCREENSHOT_TIER_TIMEOUT_MS).toBeGreaterThan(LONGEST_CAPTURE_STABILITY_WAIT_MS);
  });

  it("negative control: the inherited browser-mode default does not leave that room", () => {
    // Without this the case above passes over any derivation at all, including one that
    // had quietly stopped scaling. 15 000 ms is what Vitest resolves for a browser-mode
    // project that states nothing, and it is what this tier carried before the wait
    // began scaling with the window — measured against the same longest wait, it is the
    // figure that does not fit.
    const INHERITED_BROWSER_MODE_TIMEOUT_MS = 15_000;
    expect(INHERITED_BROWSER_MODE_TIMEOUT_MS).not.toBeGreaterThan(
      LONGEST_CAPTURE_STABILITY_WAIT_MS,
    );
    // And the longest wait is genuinely several windows' worth, so the case above is
    // not satisfied by a rule that had collapsed to the per-window figure.
    expect(LONGEST_CAPTURE_STABILITY_WAIT_MS).toBeGreaterThan(STABILITY_WAIT_PER_VIEWPORT_MS);
  });
});
