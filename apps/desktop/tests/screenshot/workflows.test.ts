// The screenshot tier: the workflows family's three surfaces, per scheme.
//
// `settled-capture.ts` owns the mechanism this file rides: every capture is written
// into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether each surface can be captured at all.
//
// WHAT IS PINNED. The family ships one destination surface and two panes, and each is
// captured here as it draws with no call to read a run or a definition through: the
// destination's frame, the run pane addressed at a run, and the builder pane on a
// definition with its node-graph and drafts slots.
//
// Three surfaces and two schemes is six captures, written afresh on whichever host
// runs the tier.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import {
  mountWorkflowBuilderPane,
  mountWorkflowRunPane,
  mountWorkflowsDestination,
} from "../helpers/feature-mounts/workflows.js";
import { type MountedView } from "../helpers/feature-mounts/mount-queries.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

/**
 * The surfaces this tier captures, each with the name its image is written under.
 *
 * A table rather than two near-identical suites: the cases differ only in which
 * surface is mounted, and a copy of the same six lines is a second place for the
 * scheme emulation or the skip guard to be forgotten.
 */
const PINNED_SURFACES: readonly {
  readonly captureName: string;
  readonly mount: () => Promise<MountedView>;
}[] = [
  { captureName: "workflows-destination", mount: mountWorkflowsDestination },
  { captureName: "workflow-run", mount: mountWorkflowRunPane },
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
    for (const scheme of COLOR_SCHEMES) {
      it(`renders ${surface.captureName} in the ${scheme} scheme`, async () => {
        // Through the system preference rather than a stamped attribute: the token
        // sheet's dark layer is a `prefers-color-scheme` block, and driving it is
        // what a default install actually resolves.
        await emulateSystemScheme(scheme);
        const mounted = await surface.mount();
        await captureSettled(mounted.element, `${surface.captureName}-${scheme}`);
      });
    }
  }
});
