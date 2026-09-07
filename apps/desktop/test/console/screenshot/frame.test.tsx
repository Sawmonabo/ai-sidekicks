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
// WHO MINTS A REFERENCE, AND WHO MAY COMPARE AGAINST ONE
//
// References are keyed by browser AND platform, and font rasterisation differs
// enough that one image cannot serve two — but the pin this tier needs is finer
// than a platform, and `baseline-platform.ts` holds it. `darwin` is not one
// machine: the committed images are what GitHub's `macos-15` runner renders, so a
// reference minted anywhere else is one no CI run will reproduce, and a comparison
// run anywhere else is red for reasons belonging to the host. That module's own
// doc block carries the reasoning, the two variables, and the measured cost of the
// pin this replaced; `baseline-host.ts` beside it reads this run's verdict once per
// file and says why on both channels, and every suite in this tier asks it rather
// than deciding for itself.
//
// They are refreshed by dispatching
// `.github/workflows/console-screenshot-baselines.yml` with `mode: regenerate` on
// the branch that changes them, reading every image in the artifact it uploads,
// and committing that tree.
//
// The fail-closed guard and the missing-reference probe are NOT pinned to any host.
// They assert how this tier behaves when a reference is absent, which is a claim
// about the runner rather than about pixels, and it holds everywhere — so the tier
// still proves something where it cannot compare.
//
// WHAT AN OPTED-IN LOCAL RUN SHOWS YOU
//
// A developer Mac is a LATER macOS with a different system UI face — the console's
// sans stack names IBM Plex Sans first, nothing self-hosts it yet, and the fallback
// is whatever `system-ui` resolves to on the host. Measured 2026-09-05 on macOS
// 26.6.1 against the `macos-15` references this tree carries, exactly one of the
// three comparisons disagrees: SIX pixels of `palette-open-light`, every one a
// corner of a `⌘` keycap glyph — the one character on these surfaces that comes
// from the host's font rather than the console's — with both frames matching
// exactly. That is this host on this tree and not a bound: the same three
// comparisons have disagreed by four figures on other machines and other reference
// vintages.
//
// The tier allows none of them. `vitest/screenshot-pins.ts`'s
// `SCREENSHOT_TIER_MATCH_OPTIONS` records why: a single changed glyph in a palette
// label moves only 20 pixels, so a budget large enough to absorb six is close
// enough to twenty to hide a punctuation change, and the tier would rather be red
// on a machine that asked for the comparison than blind on the runner's. So read an
// opted-in red by looking at the diff the run writes into `.vitest-attachments/`
// rather than at its pixel count — glyph corners are the host, a moved element is
// yours. For scale: a one-pixel rail move is 3 690 pixels, and the stale palette
// reference this lane found (a Help group that had appeared since the capture) was
// 26 016.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, pressKeys, renderSettled } from "../console-harness.js";
import {
  requireCapturedElement,
  screenshotUpdateMode,
  skipOffBaselineHost,
  warnOnceOffBaselineHost,
} from "./baseline-host.js";
import { captureSettled } from "./settled-capture.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenarios/first-run.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/**
 * A reference name nothing commits, reserved for the missing-reference probe.
 *
 * Deliberately not a plausible component name: the probe's whole premise is that
 * no image exists under it, and a name a family might later use for a real
 * baseline would turn the probe into a test that silently stopped probing.
 */
const UNCOMMITTED_REFERENCE_NAME = "no-reference-is-committed-under-this-name";

/** What the console's outermost mounted element is, and what this file captures. */
const FRAME_SELECTOR = ".meridian-frame";

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
      screenshotUpdateMode,
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
      screenshotUpdateMode !== "none",
      `the fail-closed probe is only meaningful while references are frozen; this run resolved "${screenshotUpdateMode}"`,
    );

    const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);
    const frame = requireCapturedElement(container, FRAME_SELECTOR);

    await expect(expect(frame).toMatchScreenshot(UNCOMMITTED_REFERENCE_NAME)).rejects.toThrowError(
      /No existing reference screenshot found/,
    );
  });
});

describe("screenshot — the frame under the first-run scenario", () => {
  // Said once at collection, on the one channel the terminal reporter forwards.
  // Without it a skipped run reports "3 skipped" and nothing else, which a reader
  // cannot tell from a tier that was quietly switched off.
  warnOnceOffBaselineHost();

  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders the ${scheme} scheme`, async (context) => {
      skipOffBaselineHost(context);
      await emulateSystemScheme(scheme);
      const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);

      await captureSettled(
        requireCapturedElement(container, FRAME_SELECTOR),
        `frame-first-run-${scheme}`,
      );
    });
  }

  it("renders the palette over the frame", async (context) => {
    // The palette is the one surface that exists on a first run, so it is the one
    // composition worth pinning before the families ship theirs: the scoped
    // context row, the grouped command list, and the chord hints in the footer.
    skipOffBaselineHost(context);
    await emulateSystemScheme("light");
    const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);
    await pressKeys("{Control>}k{/Control}");
    await pressKeys("{Meta>}k{/Meta}");

    requireCapturedElement(container, FRAME_SELECTOR);
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    // The whole body, not the frame: the palette portals out of the frame's
    // subtree into the overlay root, so a frame-scoped shot would miss it.
    await captureSettled(document.body, "palette-open-light");
  });
});
