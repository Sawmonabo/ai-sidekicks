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
//
// WHO MINTS A REFERENCE
//
// `darwin` is not one machine. The committed images are the ones GitHub's
// `macos-15` runner renders, and that runner is the AUTHORITY: `ci.yml`'s
// `console-screenshot-macos` job compares against them there, so a reference
// minted anywhere else is one no CI run will reproduce. They are refreshed by
// dispatching `.github/workflows/console-screenshot-baselines.yml` with
// `mode: regenerate` on the branch that changes them, reading every image in the
// artifact it uploads, and committing that tree.
//
// A developer Mac is a LATER macOS with a different system UI face — the console's
// sans stack names IBM Plex Sans first, nothing self-hosts it yet, and the fallback
// is whatever `system-ui` resolves to on the host. So a local run is ADVISORY, and
// it is advisory in a specific and small way: measured 2026-09-02 on macOS 26.6.1
// against `macos-15` references, the whole disagreement is SIX pixels — one in
// `frame-first-run-light`, six in `palette-open-light`, none in the dark frame —
// and every one of them is a corner of a `⌘` keycap glyph, the one character on
// these surfaces that comes from the host's font rather than the console's.
//
// The tier allows none of them. `vitest.config.ts`'s `SCREENSHOT_TIER_MATCH_OPTIONS`
// records why: a single changed glyph in a palette label moves only 20 pixels, so a
// budget large enough to absorb six is close enough to twenty to hide a punctuation
// change, and the tier would rather be red on a developer's machine than blind on
// the runner's. So read a local red the way the numbers make it readable — a
// handful of pixels on a keycap is the known residue; anything else is yours. A
// one-pixel rail move is 3 690 pixels; the stale palette reference this lane found
// (a Help group that had appeared since the capture) was 26 016.

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
