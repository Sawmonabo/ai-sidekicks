// The screenshot tier: the workflows feature's three views, per scheme. `settled-capture.ts` owns
// the mechanism: every capture is written into the gitignored `__screenshots__/` and compared
// against nothing, so this file gates on whether each view can be captured at all. The feature
// ships one destination screen and two panes, each captured as it draws with no call to read a
// run or a definition: the destination's frame, the run pane addressed at a run, and the builder
// pane on a definition with its node-graph and drafts regions.

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
 * The views this tier captures, each with the name its image is written under. A table because
 * the cases differ only in the mounted view, and a copy per view is one more place to forget the
 * scheme emulation.
 */
const PINNED_VIEWS: readonly {
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
  // Leave the emulation off so a later file's capture is not taken under this file's last scheme.
  await emulateSystemScheme("light");
});

describe("screenshot — the workflows views", () => {
  for (const view of PINNED_VIEWS) {
    for (const scheme of COLOR_SCHEMES) {
      it(`renders ${view.captureName} in the ${scheme} scheme`, async () => {
        // Through the system preference, not a stamped attribute: the token sheet's dark layer is
        // a `prefers-color-scheme` block, which is what a default install resolves.
        await emulateSystemScheme(scheme);
        const mounted = await view.mount();
        await captureSettled(mounted.element, `${view.captureName}-${scheme}`);
      });
    }
  }
});
