// Every strip state renders its own shape, the two grammars stay apart, and the strip
// names nothing.
//
// The first claim is about a SET — five states, five renderings — so the tests drive
// `WORKFLOW_STRIP_STATES` rather than five hand-listed arms beside it. A sixth arm
// added to the union and forgotten here fails the exhaustiveness case rather than
// passing silently, which is the property a hand-listed set cannot have.
//
// The second is the one worth a test of its own: a refusal is NOT an absence. Both
// would look like "something is wrong" to a reader skimming the markup, and only the
// refusal carries the daemon's code — so the refusal case asserts the code is on
// screen, and the absence cases assert it is not the shape they took.
//
// THE THIRD IS WHAT THIS FILE IS FOR NOW. The strip used to draw the family's own pane
// chrome: a `<section>`, a kind glyph and an `<h2>`. Every pane in the console wears
// `seats/ConsolePaneChrome`, whose crumb trail IS the pane's accessible name — so a
// heading inside the body would name the pane a second time and a region inside the
// body would give a person navigating by region two stops for one surface. The
// heading cases that used to live here moved to `WorkflowsSurface.test.tsx`, which is
// the one surface in this family that is not a pane and therefore still names itself;
// what is left here asserts the absence, because a heading that crept back would look
// like an improvement in a diff.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { WorkflowStateStrip } from "./WorkflowStateStrip.js";
import {
  WORKFLOW_STRIP_STATES,
  refusedWorkflowStrip,
  unaskedWorkflowStrip,
  type WorkflowStripState,
  type WorkflowStripStateKind,
} from "./strip-state.js";

/** One state per arm, so a walk over the closed set can render all five. */
const STATE_BY_KIND: Readonly<Record<WorkflowStripStateKind, WorkflowStripState>> = {
  "not-checked": unaskedWorkflowStrip("Nobody asked.", "The read happens elsewhere."),
  "not-loaded": { kind: "not-loaded", title: "Reading." },
  empty: { kind: "empty", title: "Nothing here.", detail: "Make one." },
  refused: refusedWorkflowStrip(
    refuse("workflows-test", "workflow.not_found", "That run is gone. Refresh the list."),
  ),
  ready: { kind: "ready" },
};

function renderStrip(state: WorkflowStripState): HTMLElement {
  const { container } = render(
    <WorkflowStateStrip summary="A summary." state={state}>
      <p data-testid="workflow-body">The body.</p>
    </WorkflowStateStrip>,
  );
  const strip = container.querySelector(".meridian-workflow__strip");
  if (!(strip instanceof HTMLElement)) {
    throw new Error("the strip rendered no root");
  }
  return strip;
}

describe("workflow state strip — what it leads with", () => {
  it("says what the surface is for, on every arm", () => {
    // Every arm and not one: the summary is the sentence a person reads while the
    // surface is telling them it has nothing, which is exactly when it matters.
    for (const kind of WORKFLOW_STRIP_STATES) {
      const summary = renderStrip(STATE_BY_KIND[kind]).querySelector(".meridian-workflow__summary");
      expect([kind, summary?.textContent]).toStrictEqual([kind, "A summary."]);
    }
  });

  it("draws no heading and no region of its own, because its host already is one", () => {
    // The defect this replaces: the strip drew a `<section aria-labelledby>` and an
    // `<h2>` per surface, so a pane wearing the console's pane chrome was named twice
    // — once by the chrome's crumb trail and once by a heading nested inside it.
    for (const kind of WORKFLOW_STRIP_STATES) {
      const strip = renderStrip(STATE_BY_KIND[kind]);
      expect([
        kind,
        strip.closest("section"),
        strip.querySelector("section, h1, h2, h3, h4, h5, h6"),
        strip.getAttribute("aria-labelledby"),
      ]).toStrictEqual([kind, null, null, null]);
    }
  });
});

describe("workflow state strip — one rendering per state", () => {
  it("renders the body on `ready` and on no other arm", () => {
    for (const kind of WORKFLOW_STRIP_STATES) {
      const strip = renderStrip(STATE_BY_KIND[kind]);
      expect([kind, strip.querySelector('[data-testid="workflow-body"]') !== null]).toStrictEqual([
        kind,
        kind === "ready",
      ]);
    }
  });

  it("gives each absence its own kind modifier", () => {
    const modifiers = (["not-checked", "not-loaded", "empty"] as const).map((kind) => {
      const absence = renderStrip(STATE_BY_KIND[kind]).querySelector(".meridian-nothing");
      return [...(absence?.classList ?? [])].find((className) => className.endsWith(`--${kind}`));
    });
    expect(modifiers).toStrictEqual([
      "meridian-nothing--not-checked",
      "meridian-nothing--not-loaded",
      "meridian-nothing--empty",
    ]);
  });

  it("renders a refusal as a refusal, carrying the daemon's code and message", () => {
    const strip = renderStrip(STATE_BY_KIND.refused);
    expect(strip.querySelector(".meridian-refusal")).not.toBeNull();
    expect(strip.textContent).toContain("workflow.not_found");
    expect(strip.textContent).toContain("That run is gone. Refresh the list.");
  });

  it("negative control: a refusal is not rendered as an absence", () => {
    // Without this, the absence cases above would still pass over a strip that
    // routed `refused` into `Nothing`'s error arm — which would drop the code.
    expect(renderStrip(STATE_BY_KIND.refused).querySelector(".meridian-nothing")).toBeNull();
  });

  it("negative control: the act slot is gone from the type, not merely unsupplied", () => {
    // Compile-time on purpose, on `WorkflowsSurface.test.tsx`'s own precedent for the
    // seams it deleted. Removing a dead prop leaves nothing to render, so no rendered
    // assertion can tell the deletion from a caller that never passed it. The
    // suppression below has nothing to suppress on the strip as it now stands and
    // `tsc` fails the file for an unused directive, which is the control — and the
    // repo's typecheck gate is what runs it.
    const { container } = render(
      <WorkflowStateStrip
        summary="A summary."
        state={STATE_BY_KIND.ready}
        // @ts-expect-error a pane-level act belongs in the pane chrome's `actions` slot
        primaryAction={<button type="button">New definition</button>}
      />,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
