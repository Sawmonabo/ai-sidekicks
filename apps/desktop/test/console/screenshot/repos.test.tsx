// The screenshot tier: the repos family's five surfaces, per scheme.
//
// `frame.test.tsx`'s header owns the mechanism this file rides — the three
// snapshot-update modes, why the references are pinned to a RUNNER rather than to a
// platform, and which machine may mint one. `baseline-platform.ts` holds the values
// and the predicate that reasoning produces, so nothing about it is restated here.
//
// WHAT IS PINNED, AND WHY THESE FIVE. The family ships one sidebar section, two pane
// bodies, and the gate a change proposal is put through — and the gate is pinned both
// on its own and where a person meets it. Each is a different composition rather than
// a state of one:
//
//   • the repos SECTION with a DEGRADED MOUNT — the scenario states two mounts and
//     one of them answers `unreachable`, and the section's design claim is that a
//     mount whose health is bad reads as bad at a glance and still offers what it
//     can. That is a claim about what is drawn, which is what an image holds and
//     what a DOM assertion reads one attribute of;
//   • the DIFF PANE over a parsed change set: the attribution badge and the compared
//     states in the header, the changed-file list, and the rows with their gutter
//     marks — the diff pane's whole surface, and the one place the intraline highlight is
//     visible as a highlight rather than as a segment list;
//   • the ARTIFACT PANE, which on this build carries the growth port's typed refusal
//     beside the shipped-default allow-list hint. A refusal is a rendered surface
//     with a remedy in it, and pinning it is how a tier notices it turning into a
//     bare error box;
//   • the PROPOSAL GATE on its prepared arm, where the branch context, the proposal,
//     its changed paths, all three offers, and the refusal beside the remote one are
//     on screen at once. All three, because the fixture's proposal is `ready`: the
//     remote act is withheld on any other state, and a refusal is looked up only for
//     an act that is offered, so a `draft` fixture would pin two rows and no refusal;
//   • the SECTION AGAIN with a root's gate DISCLOSED, which is the only subject that
//     holds the mount: the gate composing inside a row it does not own, under the
//     execution root it was asked about, on whatever arm the fixture actually served.
//
// Five surfaces and two schemes is ten references, and every one of them is minted
// on the `macos-15` runner through `.github/workflows/console-screenshot-baselines.yml`.
// A local run on any other host skips; a local run on a developer Mac is advisory in
// the small, measured way `frame.test.tsx` records.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import { server } from "vitest/browser";

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
import { baselineSkipReason, comparesBaselines, readBaselineHost } from "./baseline-platform.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/**
 * The surfaces this tier pins, each with the reference name it is committed under.
 *
 * A table rather than four near-identical suites: the cases differ only in which
 * surface is mounted, and four copies of the same six lines is four places for the
 * scheme emulation or the skip guard to be forgotten in one of them.
 */
// THE HOST READING IS BOUND HERE AND NOT IN `baseline-platform.ts`, which is where a
// reader who has seen `frame.test.tsx` do the same three lines will look for it. That
// module is imported by `vitest/console-projects.ts` — a config file Vitest loads in
// NODE, to widen `envPrefix` by the prefix the two variables share — so a
// `vitest/browser` import at its top would put a browser-only module into the program
// that configures the run. It stays a pure predicate over an environment record for
// that reason, and each browser-mode suite hands it its own reading.

/** What this host declared about itself, off Vite's resolved env — there is no `process` in the page. */
const baselineHost = readBaselineHost(server.config.env);

/** Whether this host is one whose comparisons mean anything. */
const comparesHere = comparesBaselines(baselineHost);

/** Why they did not run here. One sentence, carried on both channels. */
const SKIP_REASON = baselineSkipReason(baselineHost);

/**
 * Skip a baseline comparison on a host that cannot reproduce the references.
 *
 * A skip with a NOTE rather than `describe.skipIf`, because the reason is the whole
 * point: a suite simply absent from the report reads exactly like one that passed.
 */
function skipOffBaselineHost(context: TestContext): void {
  context.skip(!comparesHere, SKIP_REASON);
}

const PINNED_SURFACES: readonly {
  readonly referenceName: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { referenceName: "repos-section-degraded-mount", mount: mountRepoSection },
  { referenceName: "repos-diff-pane", mount: mountDiffPane },
  { referenceName: "repos-artifact-pane", mount: mountArtifactPane },
  {
    referenceName: "repos-artifact-pane-payload-deferred",
    mount: mountArtifactPaneDeferredPayload,
  },
  { referenceName: "repos-artifact-pane-payload-inline", mount: mountArtifactPaneInlinePayload },
  { referenceName: "repos-proposal-gate", mount: mountProposalGate },
  { referenceName: "repos-section-mounted-gate", mount: mountRepoSectionWithOpenGate },
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
  // Said once at collection, on the one channel the terminal reporter forwards: a
  // bare skipped count reads exactly like a tier that was quietly switched off.
  if (!comparesHere) {
    console.warn(SKIP_REASON);
  }

  for (const surface of PINNED_SURFACES) {
    for (const scheme of CONSOLE_SCHEMES) {
      it(`renders ${surface.referenceName} in the ${scheme} scheme`, async (context) => {
        skipOffBaselineHost(context);
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
