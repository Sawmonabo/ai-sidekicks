// The two things a person can press, and what each does with a page still in flight.
//
// Both suites are about controls the CALLER supplies rather than about the rows, so
// they read the whole browser: the open and import affordances live inside the scope
// groups, and the continuation region is a sibling of them.

import { describe, expect, it, vi } from "vitest";

import { definition } from "../workflows-probe.test-support.js";
import { DefinitionsBrowser } from "./DefinitionsBrowser.js";
import {
  groupFor,
  renderDefinitionsBrowser,
  renderScopeList,
  rowNames,
} from "./DefinitionsBrowser.test-support.js";
import { refuse } from "../../core/index.js";

/** The one control the continuation region draws, or nothing. */
function continuationControl(container: HTMLElement): HTMLButtonElement | null {
  const control = container.querySelector(".meridian-definitions-continuation button");
  return control instanceof HTMLButtonElement ? control : null;
}

describe("the controls", () => {
  it("draws no control at all while its caller supplies none", () => {
    const list = renderScopeList(<DefinitionsBrowser definitions={[definition({ id: "one" })]} />);
    expect(list.querySelectorAll("button")).toHaveLength(0);
  });

  it("opens a definition through its own name, and hands the whole row back", () => {
    const openDefinition = vi.fn();
    const row = definition({ id: "one", name: "Release checklist" });
    const list = renderScopeList(
      <DefinitionsBrowser definitions={[row]} onOpenDefinition={openDefinition} />,
    );
    const button = list.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("the row rendered no open control");
    }
    button.click();
    // The whole summary travels, so whatever opens the detail already holds the
    // hash, the version reference, and the scope reference it needs.
    expect(openDefinition).toHaveBeenCalledWith(row);
  });
});

describe("the continuation", () => {
  const held = [definition({ id: "held-one", name: "Held one" })];

  it("draws no control while its caller holds no cursor", () => {
    // "Absent, not disabled", the same rule every other control here obeys: a browser
    // whose caller has the last page offers no handle to a page that does not exist.
    expect(
      continuationControl(renderDefinitionsBrowser(<DefinitionsBrowser definitions={held} />)),
    ).toBe(null);
  });

  it("draws the control once its caller supplies the ask, and hands the press back", () => {
    // The negative control for the case above, which would otherwise pass over a
    // browser that had no continuation region at all.
    const continueReading = vi.fn();
    const container = renderDefinitionsBrowser(
      <DefinitionsBrowser definitions={held} onContinueReading={continueReading} />,
    );

    const control = continuationControl(container);
    expect(control?.textContent).toBe("Show more definitions");
    control?.click();
    expect(continueReading).toHaveBeenCalledTimes(1);
  });

  it("reads as a wait rather than as a control while the next page is in flight", () => {
    const container = renderDefinitionsBrowser(
      <DefinitionsBrowser
        definitions={held}
        continuationReading={{ kind: "reading" }}
        onContinueReading={() => undefined}
      />,
    );

    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(container.textContent).toContain("Reading more definitions.");
    expect(continuationControl(container)).toBe(null);
    // The rows held stay on screen through the wait: they were served, and a page in
    // flight says nothing about them.
    expect(rowNames(groupFor(container, "session"))).toStrictEqual(["Held one"]);
  });

  it("renders a refused continuation beside the control, keeping the rows shown", () => {
    const refused = refuse(
      "workflows-test",
      "workflow.definition_not_found",
      "That page of the enumeration is gone.",
    );
    const container = renderDefinitionsBrowser(
      <DefinitionsBrowser
        definitions={held}
        continuationReading={{ kind: "refused", scope: "beside-an-answer", refusal: refused }}
        onContinueReading={() => undefined}
      />,
    );

    expect(container.textContent).toContain("workflow.definition_not_found");
    expect(container.textContent).toContain(refused.detail);
    // The refusal names what it is a refusal OF, and says the rows below it stand.
    // Before the shared reading vocabulary this was a bare code and detail, which a
    // person met with no sentence saying whether the list they were looking at had
    // just been withdrawn.
    expect(container.textContent).toContain(
      "The read of more definitions was refused, so what is shown here is not the whole of it.",
    );
    // Beside, not instead of: the same ask is what a person retries.
    expect(continuationControl(container)).not.toBe(null);
    expect(rowNames(groupFor(container, "session"))).toStrictEqual(["Held one"]);
  });
});
