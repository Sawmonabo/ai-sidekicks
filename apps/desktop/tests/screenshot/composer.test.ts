// The screenshot tier: the composer feature's views, per scheme. `settled-capture.ts` owns the
// mechanism: every capture is written into the gitignored `__screenshots__/` and compared against
// nothing, so this file gates on whether each view can be captured at all.
//
// The composer's design claim is about addressing: a path label reading _new turn_ or _steer_ from
// the target run's subscribed state, never predicted, and a placeholder that names the target. A
// DOM assertion reading one attribute cannot hold that; an image can. The captures are the
// session's own composer (what focus outside the pane layout addresses), a working run (the
// new-turn path) and a run waiting on a person (the _steer_ address, where the composer scenario
// ends). The capture count is derived from the table below, not written here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import {
  mountComposerProviderBoundRunning,
  mountComposerProviderBoundWaiting,
  mountComposerSessionDefault,
} from "../helpers/feature-mounts/composer.js";
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
  { captureName: "composer-session-default", mount: mountComposerSessionDefault },
  { captureName: "composer-provider-bound-running", mount: mountComposerProviderBoundRunning },
  { captureName: "composer-provider-bound-waiting", mount: mountComposerProviderBoundWaiting },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off so a later file's capture is not taken under this file's last scheme.
  await emulateSystemScheme("light");
});

/**
 * Every capture this file writes, one per view per scheme. The cross product is taken once, so the
 * count asserted below is the value the loop runs.
 */
const PINNED_CAPTURES: readonly {
  readonly captureName: string;
  readonly scheme: (typeof COLOR_SCHEMES)[number];
  readonly mount: () => Promise<MountedView>;
}[] = PINNED_VIEWS.flatMap((view) =>
  COLOR_SCHEMES.map((scheme) => ({
    captureName: `${view.captureName}-${scheme}`,
    scheme,
    mount: view.mount,
  })),
);

describe("screenshot — the composer views", () => {
  // Reads the table, not the renderer, so it runs everywhere. A duplicate capture name is silent
  // where captures are minted (the second overwrites the first and both cases go green against
  // one image).
  it("writes one distinctly-named capture per view per scheme", () => {
    expect(PINNED_CAPTURES).toHaveLength(PINNED_VIEWS.length * COLOR_SCHEMES.length);
    expect(new Set(PINNED_CAPTURES.map((capture) => capture.captureName)).size).toBe(
      PINNED_CAPTURES.length,
    );
  });

  for (const capture of PINNED_CAPTURES) {
    it(`renders ${capture.captureName}`, async () => {
      // Through the system preference, not a stamped attribute: the token sheet's dark layer is a
      // `prefers-color-scheme` block, which is what a default install resolves.
      await emulateSystemScheme(capture.scheme);
      const mounted = await capture.mount();

      await captureSettled(mounted.element, capture.captureName);
    });
  }
});
