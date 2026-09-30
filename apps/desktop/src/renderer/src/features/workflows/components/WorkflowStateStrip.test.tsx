// Every strip state renders its own shape, a refusal is not an absence, and the strip draws no
// heading or region. Driven over `WORKFLOW_STRIP_STATES` so an arm added and forgotten here
// fails the exhaustiveness case. `PaneFrame`'s crumb trail is the pane's accessible name, so a
// heading in the body would name the pane twice.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";
import { WorkflowStateStrip } from "./WorkflowStateStrip.js";
import {
  WORKFLOW_STRIP_STATES,
  refusedWorkflowStrip,
  type WorkflowStripState,
  type WorkflowStripStateKind,
} from "../strip-state.js";

/** One state per arm, so a walk over the closed set can render all four. */
const STATE_BY_KIND: Readonly<Record<WorkflowStripStateKind, WorkflowStripState>> = {
  "not-loaded": { kind: "not-loaded", title: "Reading." },
  empty: { kind: "empty", title: "Nothing here." },
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
  it("says what the view is for, on every arm", () => {
    // Every arm: the summary matters most when the view says it has nothing.
    for (const kind of WORKFLOW_STRIP_STATES) {
      const summary = renderStrip(STATE_BY_KIND[kind]).querySelector(".meridian-workflow__summary");
      expect([kind, summary?.textContent]).toStrictEqual([kind, "A summary."]);
    }
  });

  it("draws no heading and no region of its own, because its host already is one", () => {
    // A `<section aria-labelledby>` or `<h2>` here would name the pane a second time.
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
    const modifiers = (["not-loaded", "empty"] as const).map((kind) => {
      const absence = renderStrip(STATE_BY_KIND[kind]).querySelector(".meridian-nothing");
      return [...(absence?.classList ?? [])].find((className) => className.endsWith(`--${kind}`));
    });
    expect(modifiers).toStrictEqual(["meridian-nothing--not-loaded", "meridian-nothing--empty"]);
  });

  it("renders a refusal as a refusal, carrying the daemon's code and message", () => {
    const strip = renderStrip(STATE_BY_KIND.refused);
    expect(strip.querySelector(".meridian-refusal")).not.toBeNull();
    expect(strip.textContent).toContain("workflow.not_found");
    expect(strip.textContent).toContain("That run is gone. Refresh the list.");
  });

  it("negative control: a refusal is not rendered as an absence", () => {
    // Guards against routing `refused` into `Nothing`'s error arm, which would drop the code.
    expect(renderStrip(STATE_BY_KIND.refused).querySelector(".meridian-nothing")).toBeNull();
  });

  it("negative control: the pane-level action prop is gone from the type, not merely unsupplied", () => {
    // Compile-time on purpose: no rendered assertion can tell a removed prop from a caller that
    // never passed it. The directive below fails `tsc` if the prop is ever added back.
    const { container } = render(
      <WorkflowStateStrip
        summary="A summary."
        state={STATE_BY_KIND.ready}
        // @ts-expect-error a pane-level action belongs in the pane frame's `actions` prop
        primaryAction={<button type="button">New definition</button>}
      />,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
