// Every chrome state renders its own shape, and the two grammars stay apart.
//
// The claim is about a SET — five states, five renderings — so the tests drive
// `WORKFLOW_CHROME_STATES` rather than five hand-listed arms beside it. A sixth arm
// added to the union and forgotten here fails the exhaustiveness case rather than
// passing silently, which is the property a hand-listed set cannot have.
//
// The second claim is the one worth a test of its own: a refusal is NOT an absence.
// Both would look like "something is wrong" to a reader skimming the markup, and
// only the refusal carries the daemon's code — so the refusal case asserts the code
// is on screen, and the absence cases assert it is not the shape they took.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { WorkflowChrome } from "./WorkflowChrome.js";
import {
  WORKFLOW_CHROME_STATES,
  refusedWorkflowChrome,
  unaskedWorkflowChrome,
  type WorkflowChromeState,
  type WorkflowChromeStateKind,
} from "./chrome-state.js";

/** One state per arm, so a walk over the closed set can render all five. */
const STATE_BY_KIND: Readonly<Record<WorkflowChromeStateKind, WorkflowChromeState>> = {
  "not-checked": unaskedWorkflowChrome("Nobody asked.", "The read happens elsewhere."),
  "not-loaded": { kind: "not-loaded", title: "Reading." },
  empty: { kind: "empty", title: "Nothing here.", detail: "Make one." },
  refused: refusedWorkflowChrome(
    refuse("workflows-test", "workflow.not_found", "That run is gone. Refresh the list."),
  ),
  ready: { kind: "ready" },
};

function renderChrome(state: WorkflowChromeState): HTMLElement {
  const { container } = render(
    <WorkflowChrome glyph="workflow" heading="Workflows" summary="A summary." state={state}>
      <p data-testid="workflow-body">The body.</p>
    </WorkflowChrome>,
  );
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the chrome rendered no section");
  }
  return section;
}

describe("workflow chrome — the header", () => {
  it("names the region by its own visible heading", () => {
    const section = renderChrome(STATE_BY_KIND.ready);
    const labelledBy = section.getAttribute("aria-labelledby");
    expect(labelledBy).not.toBeNull();
    expect(section.querySelector(`#${String(labelledBy)}`)?.textContent).toBe("Workflows");
  });

  it("renders no primary action when the caller offers none", () => {
    // "Absent, not disabled": a control with nothing behind it is not drawn.
    expect(renderChrome(STATE_BY_KIND.ready).querySelector("button")).toBeNull();
  });

  it("renders the primary action the caller supplies", () => {
    // Negative control for the case above: it would pass over a chrome that never
    // rendered an action at all.
    const { container } = render(
      <WorkflowChrome
        glyph="workflow"
        heading="Workflows"
        summary="A summary."
        state={STATE_BY_KIND.ready}
        primaryAction={<button type="button">New definition</button>}
      />,
    );
    expect(container.querySelector("button")?.textContent).toBe("New definition");
  });
});

describe("workflow chrome — one rendering per state", () => {
  it("renders the body on `ready` and on no other arm", () => {
    for (const kind of WORKFLOW_CHROME_STATES) {
      const section = renderChrome(STATE_BY_KIND[kind]);
      expect([kind, section.querySelector('[data-testid="workflow-body"]') !== null]).toStrictEqual(
        [kind, kind === "ready"],
      );
    }
  });

  it("gives each absence its own kind modifier", () => {
    const modifiers = (["not-checked", "not-loaded", "empty"] as const).map((kind) => {
      const absence = renderChrome(STATE_BY_KIND[kind]).querySelector(".meridian-nothing");
      return [...(absence?.classList ?? [])].find((className) => className.endsWith(`--${kind}`));
    });
    expect(modifiers).toStrictEqual([
      "meridian-nothing--not-checked",
      "meridian-nothing--not-loaded",
      "meridian-nothing--empty",
    ]);
  });

  it("renders a refusal as a refusal, carrying the daemon's code and message", () => {
    const section = renderChrome(STATE_BY_KIND.refused);
    expect(section.querySelector(".meridian-refusal")).not.toBeNull();
    expect(section.textContent).toContain("workflow.not_found");
    expect(section.textContent).toContain("That run is gone. Refresh the list.");
  });

  it("negative control: a refusal is not rendered as an absence", () => {
    // Without this, the absence cases above would still pass over a chrome that
    // routed `refused` into `Nothing`'s error arm — which would drop the code.
    expect(renderChrome(STATE_BY_KIND.refused).querySelector(".meridian-nothing")).toBeNull();
  });
});
