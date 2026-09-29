// The screenshot tier: the composer feature's views, per scheme.
//
// `settled-capture.ts` owns the mechanism this file rides: every capture is written
// into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether each view can be captured at all.
//
// WHAT IS PINNED, AND WHY. The composer is one component whose whole design claim is
// about ADDRESSING. The session composer's own design
// fixes the half that decides these images — "a path label under the input
// reading _new turn_ or _steer_ from the target run's subscribed state and never
// predicted" — and this composer's own rule is that the placeholder names the target
// too. That claim is invisible to a DOM assertion reading one attribute and is
// exactly what an image holds, so the addresses are captured rather than described:
//
//   • the session's own composer, which is what focus outside the pane layout addresses —
//     the composition a person meets first;
//   • a working run, the new-turn path;
//   • a run waiting on a person, which is the one address that sketch labels
//     _steer_ and the state the composer scenario deliberately ends on.
//
// HOW MANY CAPTURES THERE ARE IS DERIVED AND NEVER WRITTEN DOWN — one per view
// per scheme, off the table below. A number in this header is a claim no gate reads,
// and it went stale the moment a view joined the table.

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
 * The views this tier captures, each with the name its image is written under.
 *
 * A table rather than one suite per view: the cases differ only in which view
 * is mounted, and a copy of the same six lines per view is one more place for the
 * scheme emulation to be forgotten.
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
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

/**
 * Every capture this file writes, one per view per scheme.
 *
 * The cross product is taken ONCE and named, so the count below is the same value
 * the loop runs and cannot be a second, hand-kept figure that drifts from it.
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
  // This one runs everywhere, including off the pinned platform: it reads the table
  // rather than the renderer. A duplicate capture name is silent on the machine
  // that mints — the second capture overwrites the first and both cases go green
  // against one image — so the uniqueness claim is asserted where it can be seen.
  it("writes one distinctly-named capture per view per scheme", () => {
    expect(PINNED_CAPTURES).toHaveLength(PINNED_VIEWS.length * COLOR_SCHEMES.length);
    expect(new Set(PINNED_CAPTURES.map((capture) => capture.captureName)).size).toBe(
      PINNED_CAPTURES.length,
    );
  });

  for (const capture of PINNED_CAPTURES) {
    it(`renders ${capture.captureName}`, async () => {
      // Through the system preference rather than a stamped attribute: the token
      // sheet's dark layer is a `prefers-color-scheme` block, and driving it is
      // what a default install actually resolves.
      await emulateSystemScheme(capture.scheme);
      const mounted = await capture.mount();

      await captureSettled(mounted.element, capture.captureName);
    });
  }
});
