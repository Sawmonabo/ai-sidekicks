// A builder with no definition offers the definitions browser; a builder with one
// mounts both reserved bodies and says plainly that it cannot save.
//
// `Spec-023 §Console Design (Meridian)` §The surface set has the workflows rail
// destination open this pane, and the browser's own empty state is where a person
// picks or starts a definition — so the unaddressed arm is a real surface rather
// than a fallback, and the test names it by the thing only that surface renders.
//
// The addressed arm is asserted on the REGIONS it mounts rather than on its copy,
// which is this family's to reword. Two of them are the reason the arm exists: an
// addressed pane that dropped its slots would look identical to one that had them
// and be useless the day a body lands.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../../bridge/scenarios/workflows.js";
import { WORKFLOWS_SESSION_ID } from "../../bridge/scenarios/workflow-fixture-data.js";
import { WORKFLOW_DEFINITION_SCOPES } from "../../workflows/DefinitionsBrowser.js";
import type { ConsolePaneContext } from "../../workspace/index.js";
import { WorkflowBuilderPane } from "./WorkflowBuilderPane.js";

/**
 * The fields the chrome reads, and nothing else.
 *
 * Cast rather than constructed, the idiom `WorkflowRunPane.test.tsx` established: a
 * real pane context carries three stores, one of which opens a database on
 * construction. The two stores travel as markers because this pane only hands them
 * on — the slots' own tests are where what a body receives is checked. The bridge is
 * real, because the no-subject arm is a browser that asks it for definitions.
 */
function paneContext(entity: ConsolePaneContext["entity"]): ConsolePaneContext {
  return {
    kind: "workflow-builder",
    entity,
    bridge: createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }),
    sessionStore: { sessionId: WORKFLOWS_SESSION_ID },
    uiStateStore: {},
    draftStore: {},
  } as unknown as ConsolePaneContext;
}

function renderPane(context: ConsolePaneContext): HTMLElement {
  const { container } = render(<WorkflowBuilderPane context={context} />);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}

// `CONSOLE_ENTITY_KINDS` registers `workflow-run` and no definition kind, so a
// definition is addressed under the nearest registered kind rather than under one
// this test invents. Wire truth over design wish: minting a kind here would be a
// closed set widened from a test.
const ADDRESSED = { kind: "workflow-run", id: "definition-01" } as const;

describe("workflow builder pane — with no definition to open", () => {
  it("renders the definitions browser's scope groups", () => {
    const headings = [
      ...renderPane(paneContext(undefined)).querySelectorAll(".meridian-workflow__scope-heading"),
    ].map((heading) => heading.textContent ?? "");
    expect(headings).toStrictEqual([...WORKFLOW_DEFINITION_SCOPES]);
  });

  it("offers no save affordance where there is nothing to save", () => {
    // Negative control for the refusal case below: it would pass over a pane that
    // rendered the same header on every arm, which would offer to save a definition
    // the person has not chosen yet.
    const section = renderPane(paneContext(undefined));
    expect(section.querySelector(".meridian-workflow__authoring")).toBeNull();
  });
});

describe("workflow builder pane — with a definition to open", () => {
  it("reports the definition as unread rather than as absent", () => {
    // Negative control for the browser case: it would pass over a pane that rendered
    // the browser whatever its address said, which would make the builder
    // unreachable.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__scope-heading")).toHaveLength(0);
    expect(section.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("mounts both reserved bodies beneath the absence", () => {
    // The chrome renders children on its `ready` arm alone, so a pane that handed it
    // a `not-checked` STATE would drop these two silently — the read's absence would
    // render and the canvas and inspector would not.
    const section = renderPane(paneContext(ADDRESSED));
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(2);
  });

  it("states that saving is unreachable rather than drawing a button that is not", () => {
    const section = renderPane(paneContext(ADDRESSED));
    const authoring = section.querySelector(".meridian-workflow__authoring");
    expect(authoring).not.toBeNull();
    expect(authoring?.querySelector("button")).toBeNull();
    expect(section.textContent ?? "").toContain("wire-unregistered");
  });
});
