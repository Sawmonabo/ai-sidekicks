// The scope model is legible before anything exists, and in resolution order.
//
// The order is the daemon's rule rather than a layout choice, so it is asserted as
// a sequence read off the rendered markup and compared against the declared tuple —
// not against three hand-typed strings, which would be a second declaration of the
// same closed set and would agree with the first only until someone edited one.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { WORKFLOW_DEFINITION_SCOPES } from "./DefinitionsBrowser.js";
import { WorkflowsSurface } from "./WorkflowsSurface.js";
import { refusedWorkflowChrome, unaskedWorkflowChrome } from "./chrome-state.js";

function renderSurface(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the surface rendered no section");
  }
  return section;
}

function scopeHeadings(section: HTMLElement): readonly string[] {
  return [...section.querySelectorAll(".meridian-workflow__scope-heading")].map(
    (heading) => heading.textContent ?? "",
  );
}

describe("definitions browser — the scope groups", () => {
  it("names all three groups in resolution order, so the scope model is legible", () => {
    const section = renderSurface(<WorkflowsSurface state={{ kind: "ready" }} />);
    expect(scopeHeadings(section)).toStrictEqual([...WORKFLOW_DEFINITION_SCOPES]);
  });

  it("renders the groups in an ordered list, so the sequence survives without sight", () => {
    const section = renderSurface(<WorkflowsSurface state={{ kind: "ready" }} />);
    expect(section.querySelector(".meridian-workflow__scopes")?.tagName).toBe("OL");
  });

  it("shows the groups on the `empty` arm too, so a read that found none still teaches", () => {
    const section = renderSurface(
      <WorkflowsSurface
        state={{ kind: "empty", title: "No definitions.", detail: "Start one." }}
      />,
    );
    expect(scopeHeadings(section)).toStrictEqual([...WORKFLOW_DEFINITION_SCOPES]);
  });

  it("negative control: a refused surface shows no groups at all", () => {
    // The cases above would pass over a surface that rendered its groups
    // unconditionally — including underneath a refusal, where the list it is
    // grouping was never obtained.
    const section = renderSurface(
      <WorkflowsSurface
        state={refusedWorkflowChrome(
          refuse("workflows-test", "workflow.not_found", "That definition is gone."),
        )}
      />,
    );
    expect(scopeHeadings(section)).toStrictEqual([]);
    expect(section.textContent).toContain("workflow.not_found");
  });

  it("says nobody asked, rather than that there are none, before the read", () => {
    const section = renderSurface(
      <WorkflowsSurface
        state={unaskedWorkflowChrome(
          "Definitions have not been read here.",
          "The read is elsewhere.",
        )}
      />,
    );
    expect(section.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(scopeHeadings(section)).toStrictEqual([]);
  });
});

describe("definitions browser — the entry points", () => {
  it("draws no control while nothing can author or import a definition", () => {
    expect(
      renderSurface(<WorkflowsSurface state={{ kind: "ready" }} />).querySelectorAll("button"),
    ).toHaveLength(0);
  });

  it("draws each control once its caller supplies the action", () => {
    // Negative control for the case above, which would otherwise pass over a
    // surface that had no entry points at all.
    const section = renderSurface(
      <WorkflowsSurface
        state={{ kind: "ready" }}
        onNewDefinition={() => undefined}
        onImportDefinition={() => undefined}
      />,
    );
    expect(
      [...section.querySelectorAll("button")].map((button) => button.textContent),
    ).toStrictEqual(["New definition", "Import a definition file"]);
  });
});
