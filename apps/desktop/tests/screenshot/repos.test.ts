// The screenshot tier: the repos family's two surfaces, per scheme.
//
// `settled-capture.ts` owns the mechanism this file rides: every capture is written
// into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether each surface can be captured at all.
//
// WHAT IS PINNED, AND WHY THESE TWO. Each is a different composition rather than a
// state of one:
//
//   • the repos SECTION with its DEGRADED MOUNTS — three mounts are stated and two of
//     them answer on the failing health verdicts, `unreachable` and `identity_mismatch`,
//     and the section's design claim is that a mount whose health is bad reads as bad
//     at a glance and still offers what it can, which on the second of those verdicts
//     means the re-attach that recovers it. That is a claim about what is drawn, which
//     is what an image holds and what a DOM assertion reads one attribute of;
//   • the DIFF PANE over a parsed change set: the compared states in the header, the
//     changed-file list, and the rows with their gutter marks — the diff pane's whole
//     surface, and the one place the intraline highlight is visible as a highlight
//     rather than as a segment list.
//
// Two surfaces and two schemes is four captures, written afresh on whichever host runs
// the tier.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../../test/console/console-harness.js";
import { mountDiffPane, mountRepoSection } from "../helpers/feature-mounts/repos.js";
import { type MountedView } from "../helpers/feature-mounts/mount-queries.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "@renderer/console/frame/index.js";
import { CONSOLE_SCHEMES } from "@renderer/styles/tokens.js";

/**
 * The surfaces this tier pins, each with the capture name it is committed under.
 *
 * A table rather than one near-identical suite per row: the cases differ only in which
 * surface is mounted, and a copy of the same six lines per surface is one more place
 * for the scheme emulation or the skip guard to be forgotten in exactly one of them.
 */
const PINNED_SURFACES: readonly {
  readonly captureName: string;
  readonly mount: () => Promise<MountedView>;
}[] = [
  { captureName: "repos-section-degraded-mount", mount: mountRepoSection },
  { captureName: "repos-diff-pane", mount: mountDiffPane },
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

describe("screenshot — the repos section and diff pane", () => {
  for (const surface of PINNED_SURFACES) {
    for (const scheme of CONSOLE_SCHEMES) {
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
