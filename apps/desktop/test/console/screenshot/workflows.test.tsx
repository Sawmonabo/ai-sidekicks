// The screenshot tier: the workflows family's two surfaces, per scheme.
//
// `frame.test.tsx`'s header owns the mechanism this file rides — the three
// snapshot-update modes, why the references are pinned to `darwin`, and which
// machine may mint one. `baseline-platform.ts` holds the values that reasoning
// produces, so nothing about it is restated here.
//
// WHAT IS PINNED, AND WHY THESE TWO. The family ships one destination surface and
// two pane chromes, and the two captured here are different compositions rather than
// states of one:
//
//   • the definitions browser, whose whole design claim is that three scope groups
//     stand in the daemon's own resolution order and that exactly one row is marked
//     as the one a run would pick — a claim about what is DRAWN, which an image
//     holds whole and a DOM assertion reads one attribute of;
//   • the run pane on the scenario's parked run, which is the frame that fixture's
//     own header says a baseline should pin: two park kinds at once, one with an
//     armed resume and one waiting on a person, beside the reserved slot shells the
//     bodies another plan owns will replace.
//
// Two surfaces and two schemes is four references, and every one of them is minted
// on the `macos-15` runner through `.github/workflows/console-screenshot-baselines.yml`.
// A local run on any other host skips; a local run on a developer Mac is advisory in
// the small, measured way `frame.test.tsx` records.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountWorkflowDefinitionsBrowser,
  mountWorkflowParkedRunPane,
  type MountedFamilySurface,
} from "../workflow-surfaces.js";
import { skipOffPinnedPlatform, warnOnceIfOffPinnedPlatform } from "./baseline-platform.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/index.js";

/**
 * The surfaces this tier pins, each with the reference name it is committed under.
 *
 * A table rather than two near-identical suites: the cases differ only in which
 * surface is mounted, and a copy of the same six lines is a second place for the
 * scheme emulation or the skip guard to be forgotten.
 */
const PINNED_SURFACES: readonly {
  readonly referenceName: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { referenceName: "workflow-definitions-browser", mount: mountWorkflowDefinitionsBrowser },
  { referenceName: "workflow-parked-run", mount: mountWorkflowParkedRunPane },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the workflows surfaces", () => {
  warnOnceIfOffPinnedPlatform();

  for (const surface of PINNED_SURFACES) {
    for (const scheme of CONSOLE_SCHEMES) {
      it(`renders ${surface.referenceName} in the ${scheme} scheme`, async (context) => {
        skipOffPinnedPlatform(context);
        // Through the system preference rather than a stamped attribute: the token
        // sheet's dark layer is a `prefers-color-scheme` block, and driving it is
        // what a default install actually resolves.
        await emulateSystemScheme(scheme);
        const mounted = await surface.mount();

        await expect(mounted.element).toMatchScreenshot(`${surface.referenceName}-${scheme}`);
      });
    }
  }
});
