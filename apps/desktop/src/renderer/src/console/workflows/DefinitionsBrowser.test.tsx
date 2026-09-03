// The browser's four rules, each with the control that proves the check bites.
//
// The one worth stating twice is the resolution mark: it is the daemon's answer
// displayed, and the test compares against the flag on the row rather than against
// the scope order — a test that asserted "the session row is marked" would pass over
// a renderer that had re-derived the walk and happened to agree.
//
// The first case below is not about the markup at all. `WorkflowDefinitionRow` is an
// ALIAS of the wire summary rather than a second declaration of it, and nothing a
// render can observe would notice the difference: a hand-written mirror renders the
// same four members right up until the reply grows a fifth. So the claim is checked
// where it lives, in the type system, with the mirror it replaced planted beside it.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowDefinitionSummary } from "../bridge/index.js";
import { refuse } from "../core/index.js";
import {
  DefinitionsBrowser,
  WORKFLOW_DEFINITION_SCOPES,
  type WorkflowDefinitionRow,
  type WorkflowDefinitionScope,
} from "./DefinitionsBrowser.js";

/**
 * Whether two types are the same type, rather than one merely fitting the other.
 *
 * Both directions, because one alone is exactly the check a stale mirror passes: a
 * reply carrying more than a mirror asks for is still assignable TO that mirror, so a
 * one-way test stays green for the whole time the view vocabulary is wrong. Each side
 * is wrapped in a tuple so the `extends` compares the types rather than distributing
 * over the members of a union.
 */
type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

/** The alias's whole claim: the browser's row IS the enumeration's reply. */
const ROW_IS_THE_WIRE_SUMMARY: MutuallyAssignable<
  WorkflowDefinitionRow,
  WorkflowDefinitionSummary
> = true;

/**
 * The foil: the mirror this file's subject used to be, one member short.
 *
 * Hand-written on purpose and short on purpose. `createdAt` stands for whichever
 * member the wire grows next — the point is that a mirror keeps compiling while the
 * reply moves past it, and that this file notices.
 */
interface DriftedDefinitionMirror {
  readonly id: string;
  readonly name: string;
  readonly scope: WorkflowDefinitionScope;
  readonly scopeRef: string;
  readonly latestVersionNumber: number;
  readonly latestWorkflowVersionId: string;
  readonly contentHash: string;
  readonly resolvesAtThisContext: boolean;
}

/**
 * The same claim about the mirror, which the compiler resolves to `false`.
 *
 * The suppressed error IS the assertion: it stops occurring — and this directive
 * becomes the error — the day a mirror missing a member starts counting as the wire
 * summary, which is the day the check would have stopped meaning anything.
 */
// @ts-expect-error — a mirror one member short is not the wire summary.
const MIRROR_THE_COMPILER_REJECTS: MutuallyAssignable<
  DriftedDefinitionMirror,
  WorkflowDefinitionSummary
> = true;

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
  function markedRows(list: HTMLElement): readonly HTMLElement[] {
    return [...list.querySelectorAll<HTMLElement>(".meridian-definition-row--resolves")];
  }

  /** The sentence assistive technology reads as the row's description, or nothing. */
  function describedTextOf(list: HTMLElement, row: HTMLElement): string | undefined {
    const describedBy = row.getAttribute("aria-describedby");
    if (describedBy === null) {
      return undefined;
    }
    return list.ownerDocument.getElementById(describedBy)?.textContent ?? undefined;
  }

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
    const marked = markedRows(list);
    expect(marked).toHaveLength(1);
    const markedRow = marked[0];
    if (markedRow === undefined) {
      throw new Error("no row carried the resolution mark");
    }
    expect(rowNames(markedRow)).toStrictEqual(["Project copy"]);
  });

  it("marks a resolving row without the interactive hue", () => {
    // Rule 3 spends the accent on interactive affordances. The mark is a fact the
    // daemon reported and the row's only control is its name, so neither the chip nor
    // the row's leading edge may carry it.
    const list = renderBrowser(
      <DefinitionsBrowser
        definitions={[
          definition({ id: "project-copy", scope: "project", resolvesAtThisContext: true }),
        ]}
      />,
    );
    const marked = markedRows(list)[0];
    if (marked === undefined) {
      throw new Error("no row carried the resolution mark");
    }
    const chip = marked.querySelector(".meridian-chip");
    expect(chip?.classList.contains("meridian-chip--accent")).toBe(false);
    expect(chip?.classList.contains("meridian-chip--neutral")).toBe(true);
    // The row's leading edge is the sheet's and this tier renders no sheet, so what is
    // asserted here is the class the sheet keys on — the edge's token moved with it,
    // and the two committed browser references are what hold that.
    expect(marked.classList.contains("meridian-definition-row--resolves")).toBe(true);
  });

  it("leaves the row's one affordance where the accent belongs", () => {
    // The guard against over-correcting the case above: neutralising the MARK is the
    // fix, and a row that had also stopped offering its name as the way in would pass
    // that case while having lost the one thing on it the accent is spent on.
    const list = renderBrowser(
      <DefinitionsBrowser
        definitions={[
          definition({ id: "project-copy", scope: "project", resolvesAtThisContext: true }),
        ]}
        onOpenDefinition={() => undefined}
      />,
    );
    const marked = markedRows(list)[0];
    const controls = marked?.querySelectorAll("button") ?? [];
    expect(controls).toHaveLength(1);
    expect(controls[0]?.className).toContain("meridian-definition-row__open");
  });

  it("negative control: nothing is marked when the daemon flagged nothing", () => {
    // The case above would pass over a renderer that marked the first `session` row
    // by re-walking the scope order — which is precisely the derivation this surface
    // is forbidden to perform.
    const list = renderBrowser(
      <DefinitionsBrowser definitions={[definition({ id: "session-copy", scope: "session" })]} />,
    );
    expect(markedRows(list)).toHaveLength(0);
    expect(list.querySelector("[aria-describedby]")).toBeNull();
  });

  it("describes each marked row rather than calling it the current one", () => {
    // Two definitions with DIFFERENT names both resolving, which is the shape the
    // finding is about: resolution is a predicate per definition name, so a scope can
    // carry several, and `aria-current` — which names the single current item in a set
    // — then said "current" about two rows without saying what either was current for.
    const list = renderBrowser(
      <DefinitionsBrowser
        definitions={[
          definition({
            id: "checklist",
            name: "Release checklist",
            scope: "session",
            resolvesAtThisContext: true,
          }),
          definition({
            id: "rollback",
            name: "Rollback drill",
            scope: "session",
            resolvesAtThisContext: true,
          }),
        ]}
      />,
    );
    const marked = markedRows(list);
    expect(marked).toHaveLength(2);
    // No row claims to be the current one, and each says what it is instead — in the
    // words the surface already renders, so the description is not second copy of the
    // predicate that could drift from the chip beside it.
    expect(list.querySelectorAll("[aria-current]")).toHaveLength(0);
    expect(marked.map((row) => describedTextOf(list, row))).toStrictEqual([
      "Resolves here",
      "Resolves here",
    ]);
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

describe("the row type", () => {
  it("is the bridge's own definition summary rather than a second declaration", () => {
    expect(ROW_IS_THE_WIRE_SUMMARY).toBe(true);
  });

  it("negative control: a hand-written mirror one member short is not that summary", () => {
    // Reads the value the `@ts-expect-error` above suppressed, so the directive is a
    // claim this file executes rather than a comment nobody runs. Without the pair,
    // the case above would pass over any mirror the reply happens to fit today.
    expect(MIRROR_THE_COMPILER_REJECTS).toBe(true);
  });
});
