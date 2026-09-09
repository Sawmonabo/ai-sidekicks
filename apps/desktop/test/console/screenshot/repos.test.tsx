// The screenshot tier: the repos family's seven surfaces, per scheme.
//
// `settled-capture.ts` owns the mechanism this file rides: every capture is written
// into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether each surface can be captured at all.
//
// WHAT IS PINNED, AND WHY THESE SEVEN. The family ships one sidebar section, two pane
// bodies, and the gate a change proposal is put through — four subjects, and seven
// captures, because two of them are captured more than once: the gate both on its own
// and where a person meets it, and the artifact pane on each of the three states its
// payload disclosure has. Each is a different composition rather than a state of one:
//
//   • the repos SECTION with its DEGRADED MOUNTS — the scenario states three mounts
//     and two of them answer on the failing health verdicts, `unreachable` and
//     `identity_mismatch`, and the section's design claim is that a mount whose
//     health is bad reads as bad at a glance and still offers what it can, which on
//     the second of those verdicts means the re-attach that recovers it. That is a
//     claim about what is drawn, which is what an image holds and what a DOM
//     assertion reads one attribute of;
//   • the DIFF PANE over a parsed change set: the attribution badge and the compared
//     states in the header, the changed-file list, and the rows with their gutter
//     marks — the diff pane's whole surface, and the one place the intraline highlight is
//     visible as a highlight rather than as a segment list;
//   • the ARTIFACT PANE, which on this build carries the growth port's typed refusal
//     beside the shipped-default allow-list hint. A refusal is a rendered surface
//     with a remedy in it, and pinning it is how a tier notices it turning into a
//     bare error box;
//   • the ARTIFACT PANE ON ITS DEFERRED PAYLOAD ARM — a content-addressed handle and
//     no bytes — and on its INLINE one, where the bytes and the encoding a reader
//     switches on are both drawn. Two captures rather than one because the two arms
//     are what the payload disclosure is FOR: an image is the only place the
//     difference between "here is where the bytes live" and "here are the bytes"
//     reads as two different surfaces rather than as one branch of a union;
//   • the PROPOSAL GATE on its prepared arm, where the branch context, the proposal,
//     its changed paths, all three offers, and the refusal beside the remote one are
//     on screen at once. All three, because the fixture's proposal is `ready`: the
//     remote act is withheld on any other state, and a refusal is looked up only for
//     an act that is offered, so a `draft` fixture would pin two rows and no refusal;
//   • the SECTION AGAIN with a root's gate DISCLOSED, which is the only subject that
//     holds the mount: the gate composing inside a row it does not own, under the
//     execution root it was asked about, on whatever arm the fixture actually served.
//
// Seven surfaces and two schemes is fourteen captures, written afresh on whichever
// host runs the tier.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountDiffPane,
  mountProposalGate,
  mountRepoSection,
  mountRepoSectionWithOpenGate,
} from "../surfaces/repos.js";
import {
  mountArtifactPane,
  mountArtifactPaneDeferredPayload,
  mountArtifactPaneInlinePayload,
} from "../surfaces/repos-artifact.js";
import { type MountedFamilySurface } from "../surfaces/repos-mount-harness.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/**
 * The surfaces this tier pins, each with the capture name it is committed under.
 *
 * A table rather than one near-identical suite per row: the cases differ only in which
 * surface is mounted, and a copy of the same six lines per surface is one more place
 * for the scheme emulation or the skip guard to be forgotten in exactly one of them.
 */
const PINNED_SURFACES: readonly {
  readonly captureName: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { captureName: "repos-section-degraded-mount", mount: mountRepoSection },
  { captureName: "repos-diff-pane", mount: mountDiffPane },
  { captureName: "repos-artifact-pane", mount: mountArtifactPane },
  {
    captureName: "repos-artifact-pane-payload-deferred",
    mount: mountArtifactPaneDeferredPayload,
  },
  { captureName: "repos-artifact-pane-payload-inline", mount: mountArtifactPaneInlinePayload },
  { captureName: "repos-proposal-gate", mount: mountProposalGate },
  { captureName: "repos-section-mounted-gate", mount: mountRepoSectionWithOpenGate },
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
