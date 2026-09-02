// The screenshot tier: the composer family's five surfaces, per scheme.
//
// `frame.test.tsx`'s header owns the mechanism this file rides — the three
// snapshot-update modes, why the references are pinned to `darwin`, and which
// machine may mint one. `baseline-platform.ts` holds the values that reasoning
// produces, so nothing about it is restated here.
//
// WHAT IS PINNED, AND WHY THESE FIVE. The composer is one component whose whole
// design claim is about ADDRESSING: `Spec-023 §Console Design (Meridian)` §6.1 says
// the placeholder names the target and the path label is derived from the target
// run's state as the wire delivered it, never predicted. That claim is invisible to
// a DOM assertion reading one attribute and is exactly what an image holds, so the
// four addresses are captured rather than described:
//
//   • the session's own default channel, which is what focus outside the deck
//     addresses — the composition a person meets first;
//   • a named channel, where the chip carries an id and states that it read no
//     label rather than inventing one;
//   • a working run, the new-turn path;
//   • a run waiting on a person, which is the one address §6.1 calls "steer" and the
//     state the composer scenario deliberately ends on.
//
// The fifth is the runs pane on its own scenario, whose §7.1 claim is likewise
// pictorial: nine wire-verbatim states, waiting rendered as blocked-on-someone
// rather than as paused, and a queue whose order is rendered and never reordered.
//
// Five surfaces and two schemes is ten references, and every one of them is minted
// on the `macos-15` runner through `.github/workflows/console-screenshot-baselines.yml`.
// A local run on any other host skips; a local run on a developer Mac is advisory in
// the small, measured way `frame.test.tsx` records.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountComposerChannelAddressed,
  mountComposerChannelDefault,
  mountComposerProviderBoundRunning,
  mountComposerProviderBoundWaiting,
  mountRunsPane,
  type MountedFamilySurface,
} from "../composer-surfaces.js";
import { skipOffPinnedPlatform, warnOnceIfOffPinnedPlatform } from "./baseline-platform.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/index.js";

/**
 * The surfaces this tier pins, each with the reference name it is committed under.
 *
 * A table rather than five near-identical suites: the cases differ only in which
 * surface is mounted, and five copies of the same six lines is five places for the
 * scheme emulation or the skip guard to be forgotten in one of them.
 */
const PINNED_SURFACES: readonly {
  readonly referenceName: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { referenceName: "composer-channel-default", mount: mountComposerChannelDefault },
  { referenceName: "composer-channel-addressed", mount: mountComposerChannelAddressed },
  { referenceName: "composer-provider-bound-running", mount: mountComposerProviderBoundRunning },
  { referenceName: "composer-provider-bound-waiting", mount: mountComposerProviderBoundWaiting },
  { referenceName: "runs-pane-live", mount: mountRunsPane },
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

describe("screenshot — the composer and runs surfaces", () => {
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
