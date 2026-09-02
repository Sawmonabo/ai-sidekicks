// The screenshot tier: the frame and the first-run scenario, per scheme.
//
// `Spec-023 §Console Test Tiers` names a screenshot tier "per component and per
// scheme". Vitest 4's `toMatchScreenshot` owns the baseline, and what it does
// about a MISSING one is a three-way branch on the run's resolved
// snapshot-update mode — not the single "first run writes it and passes"
// behaviour it is easy to assume:
//
//   • `none`  — a missing reference FAILS and the candidate image is written to
//               the gitignored attachments directory, never beside the committed
//               references. This is what CI resolves, and what the tier's own
//               script pins so a local run gates the same way.
//   • `new`   — a missing reference FAILS on that run and is written STRAIGHT
//               INTO `__screenshots__`, so the very next run compares against an
//               unreviewed image and passes. That is the mode this tier refuses:
//               see the fail-closed guard below.
//   • `all`   — `-u`. Both a missing and a mismatched reference are rewritten and
//               pass. The deliberate "I have looked at the candidate and it is
//               correct" gesture, and the only supported way to mint a baseline.
//
// WHY ONE PINNED PLATFORM
//
// References are keyed by browser AND platform, and font rasterisation differs
// enough between platforms that one image cannot serve two. Committing a baseline
// per platform would mean reviewing every visual change three times over images
// nobody can regenerate locally, so this tier is pinned to ONE: `darwin`, which is
// the platform whose references are committed, and the platform CI runs it on
// (`.github/workflows/ci.yml`, the `console-screenshot-macos` job). On any other
// platform the baseline comparisons SKIP with a stated reason — a captured image
// there would compare against nothing, and a tier that quietly wrote itself a
// reference on an ephemeral checkout would be permanently on its first run and
// would never compare anything at all.
//
// The fail-closed guard and the missing-reference probe are NOT platform-pinned.
// They assert how this tier behaves when a reference is absent, which is a claim
// about the runner rather than about pixels, and it holds on every platform — so
// the tier still proves something where it cannot compare.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import { server } from "vitest/browser";

import { emulateSystemScheme, pressKeys, renderSettled } from "../console-harness.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenarios/first-run.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/index.js";

/**
 * The one platform whose references are committed, and the one CI compares on.
 *
 * Stated once and read by both the skip guard and the messages it produces, so the
 * name a skipped run prints and the name the guard tests are the same string.
 */
const PINNED_BASELINE_PLATFORM = "darwin";

/**
 * A reference name nothing commits, reserved for the missing-reference probe.
 *
 * Deliberately not a plausible component name: the probe's whole premise is that
 * no image exists under it, and a name a family might later use for a real
 * baseline would turn the probe into a test that silently stopped probing.
 */
const UNCOMMITTED_REFERENCE_NAME = "no-reference-is-committed-under-this-name";

/** The run's resolved snapshot-update mode — the branch the mechanism above names. */
const updateMode = server.config.snapshotOptions.updateSnapshot;

/** Whether this host is one the committed references cannot serve. */
const isOffPinnedPlatform = server.platform !== PINNED_BASELINE_PLATFORM;

/** Why the comparisons did not run here. One sentence, carried on both channels. */
const OFF_PLATFORM_REASON =
  `[console-screenshot] baseline comparisons skipped: references are committed for ` +
  `${PINNED_BASELINE_PLATFORM} and this host is ${server.platform}. This tier compares on ` +
  `${PINNED_BASELINE_PLATFORM} only — capturing here would compare against nothing.`;

/**
 * Skip a baseline comparison that has no committed reference on this host.
 *
 * A skip with a NOTE rather than `describe.skipIf`, because the reason is the
 * whole point: a reader of a green run on Linux has to be able to see that the
 * comparisons did not run and why, and a suite that is simply absent from the
 * report reads exactly like one that passed. The note reaches structured
 * reporters; the terminal one prints a bare "skipped" count, which is why the
 * suite below also says it once on the console channel that reporter forwards.
 */
function skipOffPinnedPlatform(context: TestContext): void {
  context.skip(isOffPinnedPlatform, OFF_PLATFORM_REASON);
}

/**
 * The mounted frame, or a throw.
 *
 * A throw rather than the assert-then-return-early shape, which turns "the console
 * did not mount" into a test that passes having screenshotted nothing.
 */
function requireFrame(container: HTMLElement): Element {
  const frame = container.querySelector(".meridian-frame");
  if (frame === null) {
    throw new Error(
      "the console rendered no .meridian-frame element, so there is nothing for this tier to compare",
    );
  }
  return frame;
}

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the tier gates rather than mints", () => {
  it("refuses the update mode that would commit an unreviewed reference", () => {
    // `new` is the one mode in which a missing reference lands in `__screenshots__`
    // and every later run compares against an image no person approved. It is also
    // Vitest's default off CI, so a bare `vitest run --project=console-screenshot`
    // resolves it — which is why this is an assertion rather than a comment.
    expect(
      updateMode,
      "this tier must not run in the `new` snapshot-update mode: a missing reference would be " +
        "written into __screenshots__ unreviewed and silently become the baseline. Run it as " +
        "`pnpm --filter @ai-sidekicks/desktop test:console-screenshot`, which pins the mode to " +
        "`none`, and mint or refresh a reference deliberately by appending `-u`.",
    ).not.toBe("new");
  });

  it("fails on a reference it has never been given, rather than writing one", async (context) => {
    // The negative control for the whole tier. Under `all` the matcher is SUPPOSED
    // to write and pass, so asserting a rejection there would assert the opposite
    // of the mode's contract — and would commit a reference for this probe's name.
    context.skip(
      updateMode !== "none",
      `the fail-closed probe is only meaningful while references are frozen; this run resolved "${updateMode}"`,
    );

    const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);
    const frame = requireFrame(container);

    await expect(expect(frame).toMatchScreenshot(UNCOMMITTED_REFERENCE_NAME)).rejects.toThrowError(
      /No existing reference screenshot found/,
    );
  });
});

describe("screenshot — the frame under the first-run scenario", () => {
  // Said once at collection, on the one channel the terminal reporter forwards.
  // Without it an off-platform run reports "3 skipped" and nothing else, which a
  // reader cannot tell from a tier that was quietly switched off.
  if (isOffPinnedPlatform) {
    console.warn(OFF_PLATFORM_REASON);
  }

  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders the ${scheme} scheme`, async (context) => {
      skipOffPinnedPlatform(context);
      await emulateSystemScheme(scheme);
      const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);

      await expect(requireFrame(container)).toMatchScreenshot(`frame-first-run-${scheme}`);
    });
  }

  it("renders the palette over the frame", async (context) => {
    // The palette is the one surface that exists on a first run, so it is the one
    // composition worth pinning before the families ship theirs: the scoped
    // context row, the grouped command list, and the chord hints in the footer.
    skipOffPinnedPlatform(context);
    await emulateSystemScheme("light");
    const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);
    await pressKeys("{Control>}k{/Control}");
    await pressKeys("{Meta>}k{/Meta}");

    requireFrame(container);
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    // The whole body, not the frame: the palette portals out of the frame's
    // subtree into the overlay root, so a frame-scoped shot would miss it.
    await expect(document.body).toMatchScreenshot("palette-open-light");
  });
});
