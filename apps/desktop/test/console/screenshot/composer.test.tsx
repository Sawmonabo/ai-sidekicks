// The screenshot tier: the composer family's surfaces, per scheme.
//
// `frame.test.tsx`'s header owns the mechanism this file rides — the three
// snapshot-update modes, why the pin is a RUNNER rather than a platform, and which
// machine may mint a reference. `baseline-host.ts` holds the guard both suites take
// and the skip it issues, so nothing about it is restated here.
//
// WHAT IS PINNED, AND WHY. The composer is one component whose whole design claim is
// about ADDRESSING. `Spec-023 §Signature Feature Composition Sketches`' Session
// Composer fixes the half that decides these images — "a path label under the input
// reading _new turn_ or _steer_ from the target run's subscribed state and never
// predicted" — and this composer's own rule is that the placeholder names the target
// too. That claim is invisible to a DOM assertion reading one attribute and is
// exactly what an image holds, so the addresses are captured rather than described:
//
//   • the session's own default channel, which is what focus outside the deck
//     addresses — the composition a person meets first;
//   • a named channel, where the chip states that it read no label rather than
//     inventing one AND rather than falling through to the words the default arm
//     uses, which is the difference these two images exist to hold apart;
//   • a working run, the new-turn path;
//   • a run waiting on a person, which is the one address that sketch labels
//     _steer_ and the state the composer scenario deliberately ends on.
//
// The pane surfaces ride the same table on their own scenarios, their claims
// likewise pictorial: the runs pane's nine wire-verbatim states and
// waiting-is-not-pausing that `runs/pane/run-status.ts` states with the
// rendered-never-reordered queue order that `bridge/queue/queue-feed.ts` states, and the
// approvals pane's own.
//
// HOW MANY REFERENCES THERE ARE IS DERIVED AND NEVER WRITTEN DOWN — one per surface
// per scheme, off the table below. A number in this header is a claim no gate reads,
// and it went stale the moment a surface joined the table. Every reference is minted
// on the `macos-15` runner through `.github/workflows/console-screenshot-baselines.yml`.
// A run anywhere else skips unless it asks — a developer Mac included, whose local
// comparison is advisory in the small, measured way `frame.test.tsx` records.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountApprovalsPane,
  mountComposerChannelAddressed,
  mountComposerChannelDefault,
  mountComposerProviderBoundRunning,
  mountComposerProviderBoundWaiting,
  mountRunsPane,
  type MountedFamilySurface,
} from "../surfaces/composer.js";
import { skipOffBaselineHost, warnOnceOffBaselineHost } from "./baseline-host.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/**
 * The surfaces this tier pins, each with the reference name it is committed under.
 *
 * A table rather than one suite per surface: the cases differ only in which surface
 * is mounted, and a copy of the same six lines per surface is one more place for the
 * scheme emulation or the skip guard to be forgotten.
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
  { referenceName: "approvals-pane-live", mount: mountApprovalsPane },
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
 * Every reference this file pins, one per surface per scheme.
 *
 * The cross product is taken ONCE and named, so the count below is the same value
 * the loop runs and cannot be a second, hand-kept figure that drifts from it.
 */
const PINNED_REFERENCES: readonly {
  readonly referenceName: string;
  readonly scheme: (typeof CONSOLE_SCHEMES)[number];
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = PINNED_SURFACES.flatMap((surface) =>
  CONSOLE_SCHEMES.map((scheme) => ({
    referenceName: `${surface.referenceName}-${scheme}`,
    scheme,
    mount: surface.mount,
  })),
);

describe("screenshot — the composer, runs, and approvals surfaces", () => {
  warnOnceOffBaselineHost();

  // This one runs everywhere, including off the pinned platform: it reads the table
  // rather than the renderer. A duplicate reference name is silent on the machine
  // that mints — the second capture overwrites the first and both cases go green
  // against one image — so the uniqueness claim is asserted where it can be seen.
  it("pins one distinctly-named reference per surface per scheme", () => {
    expect(PINNED_REFERENCES).toHaveLength(PINNED_SURFACES.length * CONSOLE_SCHEMES.length);
    expect(new Set(PINNED_REFERENCES.map((reference) => reference.referenceName)).size).toBe(
      PINNED_REFERENCES.length,
    );
  });

  for (const reference of PINNED_REFERENCES) {
    it(`renders ${reference.referenceName}`, async (context) => {
      skipOffBaselineHost(context);
      // Through the system preference rather than a stamped attribute: the token
      // sheet's dark layer is a `prefers-color-scheme` block, and driving it is
      // what a default install actually resolves.
      await emulateSystemScheme(reference.scheme);
      const mounted = await reference.mount();

      await captureSettled(mounted.element, reference.referenceName);
    });
  }
});
