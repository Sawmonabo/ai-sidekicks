// The browser's four rules, each with the control that proves the check bites.
//
// The one worth stating twice is the resolution mark: it is the daemon's answer
// displayed, and the test compares against the flag on the row rather than against
// the scope order — a test that asserted "the session row is marked" would pass over
// a renderer that had re-derived the walk and happened to agree.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../core/index.js";
import {
  DefinitionsBrowser,
  WORKFLOW_DEFINITION_SCOPES,
  type WorkflowDefinitionRow,
} from "./DefinitionsBrowser.js";

function definition(overrides: Partial<WorkflowDefinitionRow> = {}): WorkflowDefinitionRow {
  return {
    id: "definition-1",
    name: "Release checklist",
    scope: "session",
    scopeRef: "session-1",
    latestVersionNumber: 3,
    latestWorkflowVersionId: "version-3",
    contentHash: "b3:0f1e2d",
    resolvesAtThisContext: false,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderBrowser(element: React.JSX.Element): HTMLElement {
  const list = renderWholeBrowser(element).querySelector(".meridian-workflow__scopes");
  if (!(list instanceof HTMLElement)) {
    throw new Error("the browser rendered no scope list");
  }
  return list;
}

/**
 * The whole browser, not just its scope list.
 *
 * The continuation region is a SIBLING of the groups rather than a member of one — the
 * cursor pages the enumeration across every scope at once — so the cases about it read
 * the container the two share.
 */
function renderWholeBrowser(element: React.JSX.Element): HTMLElement {
  return render(element).container;
}

function continuationControl(container: HTMLElement): HTMLButtonElement | null {
  const control = container.querySelector(".meridian-definitions-continuation button");
  return control instanceof HTMLButtonElement ? control : null;
}

function groupFor(list: HTMLElement, scope: string): HTMLElement {
  const groups = [...list.querySelectorAll<HTMLElement>(".meridian-workflow__scope")];
  const group = groups.find(
    (candidate) =>
      candidate.querySelector(".meridian-workflow__scope-heading")?.textContent === scope,
  );
  if (group === undefined) {
    throw new Error(`no group rendered for scope ${scope}`);
  }
  return group;
}

function rowNames(group: HTMLElement): readonly string[] {
  return [...group.querySelectorAll(".meridian-definition-row__name")].map(
    (name) => name.textContent ?? "",
  );
}

describe("the scope groups", () => {
  it("names all three in the daemon's resolution order", () => {
    const list = renderBrowser(<DefinitionsBrowser definitions={[]} />);
    expect(
      [...list.querySelectorAll(".meridian-workflow__scope-heading")].map(
        (heading) => heading.textContent,
      ),
    ).toStrictEqual([...WORKFLOW_DEFINITION_SCOPES]);
  });

  it("files each definition under its own scope and under no other", () => {
    const list = renderBrowser(
      <DefinitionsBrowser
        definitions={[
          definition({ id: "in-session", name: "Session one", scope: "session" }),
          definition({ id: "in-shared", name: "Shared one", scope: "shared" }),
        ]}
      />,
    );
    expect(rowNames(groupFor(list, "session"))).toStrictEqual(["Session one"]);
    expect(rowNames(groupFor(list, "project"))).toStrictEqual([]);
    expect(rowNames(groupFor(list, "shared"))).toStrictEqual(["Shared one"]);
  });

  it("states the copy-on-write consequence on `shared` and on no other group", () => {
    const list = renderBrowser(<DefinitionsBrowser definitions={[]} />);
    expect(
      groupFor(list, "shared").querySelector(".meridian-workflow__scope-consequence")?.textContent,
    ).toContain("never changes it");
    expect(
      groupFor(list, "session").querySelector(".meridian-workflow__scope-consequence"),
    ).toBeNull();
  });
});

describe("the resolution mark", () => {
  it("marks exactly the row the daemon flagged", () => {
    const list = renderBrowser(
      <DefinitionsBrowser
        definitions={[
          definition({ id: "session-copy", name: "Session copy", scope: "session" }),
          definition({
            id: "project-copy",
            name: "Project copy",
            scope: "project",
            resolvesAtThisContext: true,
          }),
        ]}
      />,
    );
    const marked = [...list.querySelectorAll<HTMLElement>('[aria-current="true"]')];
    expect(marked).toHaveLength(1);
    const markedRow = marked[0];
    if (markedRow === undefined) {
      throw new Error("no row carried the resolution mark");
    }
    expect(rowNames(markedRow)).toStrictEqual(["Project copy"]);
  });

  it("negative control: nothing is marked when the daemon flagged nothing", () => {
    // The case above would pass over a renderer that marked the first `session` row
    // by re-walking the scope order — which is precisely the derivation this surface
    // is forbidden to perform.
    const list = renderBrowser(
      <DefinitionsBrowser definitions={[definition({ id: "session-copy", scope: "session" })]} />,
    );
    expect(list.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });
});

describe("the absence a group shows", () => {
  it("says nothing is here once the read for that scope has come back", () => {
    const list = renderBrowser(<DefinitionsBrowser definitions={[]} />);
    expect(groupFor(list, "project").querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("says the read is still arriving for a scope whose page is in flight", () => {
    const list = renderBrowser(<DefinitionsBrowser definitions={[]} pendingScopes={["project"]} />);
    expect(groupFor(list, "project").querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    // Negative control on the same render: a scope that is NOT pending still reads
    // as empty, so the two arms are told apart by the flag and not by the component
    // having one shape.
    expect(groupFor(list, "session").querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});

describe("refusals", () => {
  const denied = refuse(
    "workflows-test",
    "workflow.control_denied",
    "You are not admitted to author at the shared scope on this node.",
  );

  it("renders the daemon's code and its message verbatim, on the scope it belongs to", () => {
    const list = renderBrowser(
      <DefinitionsBrowser definitions={[]} scopeRefusals={{ shared: denied }} />,
    );
    const shared = groupFor(list, "shared");
    expect(shared.textContent).toContain("workflow.control_denied");
    expect(shared.textContent).toContain(denied.detail);
    expect(groupFor(list, "session").textContent).not.toContain("workflow.control_denied");
  });

  it("keeps the group's rows under the refusal, because nothing was withdrawn", () => {
    const list = renderBrowser(
      <DefinitionsBrowser
        definitions={[definition({ id: "shared-one", name: "Shared one", scope: "shared" })]}
        scopeRefusals={{ shared: denied }}
      />,
    );
    expect(rowNames(groupFor(list, "shared"))).toStrictEqual(["Shared one"]);
  });
});

describe("the controls", () => {
  it("draws no control at all while its caller supplies none", () => {
    const list = renderBrowser(<DefinitionsBrowser definitions={[definition({ id: "one" })]} />);
    expect(list.querySelectorAll("button")).toHaveLength(0);
  });

  it("opens a definition through its own name, and hands the whole row back", () => {
    const openDefinition = vi.fn();
    const row = definition({ id: "one", name: "Release checklist" });
    const list = renderBrowser(
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

  it("offers import in the group an import lands in, and in no other", () => {
    const list = renderBrowser(
      <DefinitionsBrowser definitions={[]} onImportDefinition={() => undefined} />,
    );
    expect([...list.querySelectorAll("button")].map((button) => button.textContent)).toStrictEqual([
      "Import a definition file",
    ]);
    expect(groupFor(list, "session").querySelector("button")).not.toBeNull();
    expect(groupFor(list, "shared").querySelector("button")).toBeNull();
  });
});

describe("the continuation", () => {
  const held = [definition({ id: "held-one", name: "Held one" })];

  it("draws no control while its caller holds no cursor", () => {
    // "Absent, not disabled", the same rule every other control here obeys: a browser
    // whose caller has the last page offers no handle to a page that does not exist.
    expect(continuationControl(renderWholeBrowser(<DefinitionsBrowser definitions={held} />))).toBe(
      null,
    );
  });

  it("draws the control once its caller supplies the ask, and hands the press back", () => {
    // The negative control for the case above, which would otherwise pass over a
    // browser that had no continuation region at all.
    const continueReading = vi.fn();
    const container = renderWholeBrowser(
      <DefinitionsBrowser definitions={held} onContinueReading={continueReading} />,
    );

    const control = continuationControl(container);
    expect(control?.textContent).toBe("Show more definitions");
    control?.click();
    expect(continueReading).toHaveBeenCalledTimes(1);
  });

  it("reads as a wait rather than as a control while the next page is in flight", () => {
    const container = renderWholeBrowser(
      <DefinitionsBrowser definitions={held} isContinuing onContinueReading={() => undefined} />,
    );

    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
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
    const container = renderWholeBrowser(
      <DefinitionsBrowser
        definitions={held}
        continuationRefusal={refused}
        onContinueReading={() => undefined}
      />,
    );

    expect(container.textContent).toContain("workflow.definition_not_found");
    expect(container.textContent).toContain(refused.detail);
    // Beside, not instead of: the same ask is what a person retries.
    expect(continuationControl(container)).not.toBe(null);
    expect(rowNames(groupFor(container, "session"))).toStrictEqual(["Held one"]);
  });
});
