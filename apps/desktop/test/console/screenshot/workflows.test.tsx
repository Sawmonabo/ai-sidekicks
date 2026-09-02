// The screenshot tier: the workflows family's three surfaces, per scheme.
//
// `frame.test.tsx`'s header owns the mechanism this file rides — the three
// snapshot-update modes, why the references are pinned to `darwin`, and which
// machine may mint one. `baseline-platform.ts` holds the values that reasoning
// produces, so nothing about it is restated here.
//
// WHAT IS PINNED, AND WHY THESE THREE. The family ships one destination surface and
// two pane chromes, and each one captured here is a different composition rather than
// a state of one:
//
//   • the workflows destination, whose whole design claim is that it names the
//     session it is reading from and then stands three scope groups in the daemon's
//     own resolution order, with exactly one row marked as the one a run would pick
//     — a claim about what is DRAWN, which an image holds whole and a DOM assertion
//     reads one attribute of. The reference keeps the name it was minted under: a
//     renamed reference is a new file beside an orphaned baseline, and the surface
//     under it is the same surface with its subject resolved.
//   • the run pane on the scenario's parked run, which is the frame that fixture's
//     own header says a baseline should pin: two park kinds at once, one with an
//     armed resume and one waiting on a person, beside the reserved slot shells the
//     bodies another plan owns will replace.
//   • the builder pane on a definition, which is its one arm that renders a body. What
//     an image holds and a DOM assertion does not is the COMPOSITION rule 7 leaves it
//     in: a header whose primary action is an inline refusal standing exactly where a
//     working control would, the not-checked absence beneath it, and the two reserved
//     slot shells under that — three claims about one frame, and whether the refusal
//     reads as the action's own is a question answered by looking.
//
// Three surfaces and two schemes is six references, and every one of them is minted
// on the `macos-15` runner through `.github/workflows/console-screenshot-baselines.yml`.
// A local run on any other host skips; a local run on a developer Mac is advisory in
// the small, measured way `frame.test.tsx` records.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountWorkflowBuilderPane,
  mountWorkflowParkedRunPane,
  mountWorkflowsDestination,
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
  { referenceName: "workflow-definitions-browser", mount: mountWorkflowsDestination },
  { referenceName: "workflow-parked-run", mount: mountWorkflowParkedRunPane },
  { referenceName: "workflow-builder-definition", mount: mountWorkflowBuilderPane },
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
