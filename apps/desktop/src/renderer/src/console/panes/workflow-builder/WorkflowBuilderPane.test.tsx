// A builder with no definition offers the definitions browser, not an empty canvas.
//
// `Spec-023 §Console Design (Meridian)` §The surface set has the workflows rail
// destination open this pane, and the browser's own empty state is where a person
// picks or starts a definition — so the unaddressed arm is a real surface rather
// than a fallback, and the test names it by the thing only that surface renders.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WORKFLOW_DEFINITION_SCOPES } from "../../workflows/WorkflowsSurface.js";
import type { ConsolePaneContext } from "../../workspace/index.js";
import { WorkflowBuilderPane } from "./WorkflowBuilderPane.js";

/** The one field the chrome reads. Cast, per `WorkflowRunPane.test.tsx`. */
function paneContext(entity: ConsolePaneContext["entity"]): ConsolePaneContext {
  return { kind: "workflow-builder", entity } as unknown as ConsolePaneContext;
}

function renderPane(context: ConsolePaneContext): HTMLElement {
  const { container } = render(<WorkflowBuilderPane context={context} />);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}

describe("workflow builder pane — with no definition to open", () => {
  it("renders the definitions browser's scope groups", () => {
    const headings = [
      ...renderPane(paneContext(undefined)).querySelectorAll(".meridian-workflow__scope-heading"),
    ].map((heading) => heading.textContent ?? "");
    expect(headings).toStrictEqual([...WORKFLOW_DEFINITION_SCOPES]);
  });
});

describe("workflow builder pane — with a definition to open", () => {
  it("reports the definition as unread rather than as absent", () => {
    // Negative control for the case above: it would pass over a pane that rendered
    // the browser whatever its address said, which would make the builder
    // unreachable.
    const section = renderPane(paneContext({ kind: "workflow-run", id: "definition-01" }));
    expect(section.querySelectorAll(".meridian-workflow__scope-heading")).toHaveLength(0);
    expect(section.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });
});
