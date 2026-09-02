// The screenshot tier: the repos family's four surfaces, per scheme.
//
// `frame.test.tsx`'s header owns the mechanism this file rides — the three
// snapshot-update modes, why the references are pinned to `darwin`, and which
// machine may mint one. `baseline-platform.ts` holds the values that reasoning
// produces, so nothing about it is restated here.
//
// WHAT IS PINNED, AND WHY THESE FOUR. The family ships one sidebar section, two pane
// bodies, and the gate a change proposal is put through, and each is a different
// composition rather than a state of one:
//
//   • the repos SECTION with a DEGRADED MOUNT — the scenario states two mounts and
//     one of them answers `unreachable`, and the section's design claim is that a
//     mount whose health is bad reads as bad at a glance and still offers what it
//     can. That is a claim about what is drawn, which is what an image holds and
//     what a DOM assertion reads one attribute of;
//   • the DIFF PANE over a parsed change set: the attribution badge and the compared
//     states in the header, the changed-file list, and the rows with their gutter
//     marks — §10.6's whole surface, and the one place the intraline highlight is
//     visible as a highlight rather than as a segment list;
//   • the ARTIFACT PANE, which on this build carries the growth port's typed refusal
//     beside the shipped-default allow-list hint. A refusal is a rendered surface
//     with a remedy in it, and pinning it is how a tier notices it turning into a
//     bare error box;
//   • the PROPOSAL GATE on its prepared arm, where the branch context, the proposal,
//     its changed paths, and the three offers are all on screen at once.
//
// Four surfaces and two schemes is eight references, and every one of them is minted
// on the `macos-15` runner through `.github/workflows/console-screenshot-baselines.yml`.
// A local run on any other host skips; a local run on a developer Mac is advisory in
// the small, measured way `frame.test.tsx` records.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountArtifactPane,
  mountDiffPane,
  mountProposalGate,
  mountRepoSection,
  type MountedFamilySurface,
} from "../repos-surfaces.js";
import { skipOffPinnedPlatform, warnOnceIfOffPinnedPlatform } from "./baseline-platform.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/index.js";

/**
 * The surfaces this tier pins, each with the reference name it is committed under.
 *
 * A table rather than four near-identical suites: the cases differ only in which
 * surface is mounted, and four copies of the same six lines is four places for the
 * scheme emulation or the skip guard to be forgotten in one of them.
 */
const PINNED_SURFACES: readonly {
  readonly referenceName: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { referenceName: "repos-section-degraded-mount", mount: mountRepoSection },
  { referenceName: "repos-diff-pane", mount: mountDiffPane },
  { referenceName: "repos-artifact-pane", mount: mountArtifactPane },
  { referenceName: "repos-proposal-gate", mount: mountProposalGate },
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

describe("screenshot — the repos, diff, artifact, and proposal surfaces", () => {
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
