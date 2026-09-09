// The screenshot tier: the workflows family's three surfaces, per scheme.
//
// `settled-capture.ts` owns the mechanism this file rides: every capture is written
// into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether each surface can be captured at all.
//
// WHAT IS PINNED, AND WHY THESE THREE. The family ships one destination surface and
// two panes, and each one captured here is a different composition rather than
// a state of one:
//
//   • the workflows destination, whose whole design claim is that it names the
//     session it is reading from and then stands three scope groups in the daemon's
//     own resolution order, with exactly one row marked as the one a run would pick
//     — a claim about what is DRAWN, which an image holds whole and a DOM assertion
//     reads one attribute of. The capture keeps the name it was first written under,
//     because the surface under it is the same surface with its subject resolved.
//   • the run pane on the scenario's parked run, which is the frame that fixture's
//     own header says a capture should hold: two park kinds at once, one with an
//     armed resume and one waiting on a person, beside the reserved slot shells the
//     bodies another plan owns will replace.
//   • the builder pane on a definition, which is its one arm that renders a body. What
//     an image holds and a DOM assertion does not is the COMPOSITION rule 7 leaves it
//     in: the pane head's own action slot holding an inline refusal where a working
//     control would stand, the not-checked absence beneath it, and the two reserved
//     slot shells under that — three claims about one frame, and whether the refusal
//     reads as the action's own is a question answered by looking.
//
// Three surfaces and two schemes is six captures, written afresh on whichever host
// runs the tier.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountWorkflowBuilderPane,
  mountWorkflowParkedRunPane,
  mountWorkflowsDestination,
  type MountedFamilySurface,
} from "../surfaces/workflows.js";
import { captureSettled } from "./settled-capture.js";
import { awaitPhaseGraphSettled } from "../phase-graph-settled.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/**
 * The surfaces this tier captures, each with the name its image is written under.
 *
 * A table rather than two near-identical suites: the cases differ only in which
 * surface is mounted, and a copy of the same six lines is a second place for the
 * scheme emulation or the skip guard to be forgotten.
 */
const PINNED_SURFACES: readonly {
  readonly captureName: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { captureName: "workflow-definitions-browser", mount: mountWorkflowsDestination },
  { captureName: "workflow-parked-run", mount: mountWorkflowParkedRunPane },
  { captureName: "workflow-builder-definition", mount: mountWorkflowBuilderPane },
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
  for (const surface of PINNED_SURFACES) {
    for (const scheme of CONSOLE_SCHEMES) {
      it(`renders ${surface.captureName} in the ${scheme} scheme`, async () => {
        // Through the system preference rather than a stamped attribute: the token
        // sheet's dark layer is a `prefers-color-scheme` block, and driving it is
        // what a default install actually resolves.
        await emulateSystemScheme(scheme);
        const mounted = await surface.mount();
        // The mount helper waits for the surface's READ. A phase graph is a
        // lazily-loaded chunk that lands after it and is then fitted at a
        // fractional scale, so this waits for the picture to stop moving; the
        // module beside this one carries what a capture taken without it pinned.
        await awaitPhaseGraphSettled(mounted.element);

        await captureSettled(mounted.element, `${surface.captureName}-${scheme}`);
      });
    }
  }
});
