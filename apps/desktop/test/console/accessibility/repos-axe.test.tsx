// The accessibility tier over the repos family's five surfaces.
//
// `frame-axe.test.tsx` runs the frame; this file runs what the family mounts INTO
// it, and it runs each surface scoped to itself rather than scanning the document,
// so a violation names the surface that owns it.
//
// Both schemes, for `frame-axe.test.tsx`'s reason: contrast is the rule most likely
// to pass in one and fail in the other, and this family has three surfaces the
// palette tests cannot reach at all — a mount card tinted by its own health verdict,
// a diff row whose intraline highlight is a tint inside a line of text, and a
// refusal banner sitting inside a pane rather than beside one.
//
// THE MOUNTED GATE IS THE OTHER CASE WORTH HAVING. A gate reached through the section
// is a `<details>` inside a card inside a list, announcing its own settlement into the
// window's live region — a nesting no other subject here has, and the one where a
// duplicated landmark, an unlabelled disclosure, or a region announced twice would
// show up.
//
// THE GATE'S OFFERS ARE ASSERTED AND NOT ONLY WALKED. Axe reports what is wrong with
// the nodes it is handed and says nothing about the nodes that are missing, so this
// file's eight clean walks would have gone on passing over a gate drawing two offers
// instead of three and no refusal at all — which is exactly what it drew, because the
// pinned proposal was `draft` and the remote act is withheld on any state but `ready`.
// One assertion over the drawn rows is what makes the fixture's props reach the DOM a
// checked claim rather than an assumption every image quietly inherited.
//
// THE DIFF PANE IS THE CASE WORTH HAVING. Its rows are a virtualized grid: the
// scroller carries the row count and each drawn row carries its index, so what a
// person using a screen reader is told about a five-thousand-line change set is a
// claim this tier is exactly the instrument for — and the pane is mounted over a
// parsed model rather than over its absence, so the nodes axe walks are the real
// rows and not an empty-state box.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountArtifactPane,
  mountArtifactPaneDeferredPayload,
  mountArtifactPaneInlinePayload,
  mountDiffPane,
  mountProposalGate,
  mountRepoSection,
  mountRepoSectionWithOpenGate,
  type MountedFamilySurface,
} from "../surfaces/repos.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/** The surfaces this family ships, each named as a reader would name it. */
const AUDITED_SURFACES: readonly {
  readonly label: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { label: "the repos section with a degraded mount", mount: mountRepoSection },
  { label: "the diff pane over a parsed change set", mount: mountDiffPane },
  { label: "the artifact pane carrying a refusal", mount: mountArtifactPane },
  {
    label: "the artifact pane on a deferred payload handle",
    mount: mountArtifactPaneDeferredPayload,
  },
  {
    label: "the artifact pane previewing inline payload bytes",
    mount: mountArtifactPaneInlinePayload,
  },
  { label: "the proposal gate on a prepared proposal", mount: mountProposalGate },
  {
    label: "the repos section with a root's gate disclosed",
    mount: mountRepoSectionWithOpenGate,
  },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the repos, diff, artifact, and proposal surfaces", () => {
  for (const surface of AUDITED_SURFACES) {
    for (const scheme of CONSOLE_SCHEMES) {
      it(`has no axe violation on ${surface.label} in the ${scheme} scheme`, async () => {
        await emulateSystemScheme(scheme);
        const mounted = await surface.mount();

        expect(describeViolations(await runTierAxe(mounted.element))).toStrictEqual([]);
      });
    }
  }

  it("draws the proposal gate's three offers and the refusal beside the remote one", async () => {
    // The composition the pinned fixture exists to show, asserted where a DOM read can
    // name what is absent. Three rows, because `PROPOSAL_ACTIONS` is closed at three
    // and a `ready` proposal offers all of them; one inline refusal, because
    // `ProposalActionGroup` looks a refusal up only for an act it is already drawing,
    // so a withheld remote act silently takes the refusal down with it.
    const mounted = await mountProposalGate();

    expect(mounted.element.querySelectorAll(".meridian-proposal-gate__act-row")).toHaveLength(3);
    expect(mounted.element.querySelectorAll(".meridian-refusal--inline")).toHaveLength(1);
  });

  it("finds a planted violation, so a clean result means something", async () => {
    // Negative control for this file's own runs: the eight cases above expect an
    // empty list, and a misconfigured run returns exactly the same empty list.
    const planted = plantAxeViolation();
    try {
      const violations = await runTierAxe(planted);
      expect(violations.map((violation) => violation.id)).toContain(PLANTED_VIOLATION_RULE_ID);
    } finally {
      planted.remove();
    }
  });
});
