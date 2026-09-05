// Where a definition is filed, how a resolving one is marked, and what an empty group
// says — the three readings a person takes off the browser without touching it.
//
// The one worth stating twice is the resolution mark: it is the daemon's answer
// displayed, and the test compares against the flag on the row rather than against
// the scope order — a test that asserted "the session row is marked" would pass over
// a renderer that had re-derived the walk and happened to agree.

import { describe, expect, it } from "vitest";

import { definition } from "../WorkflowsBrowser.test-support.js";
import { DefinitionsBrowser, WORKFLOW_DEFINITION_SCOPES } from "./DefinitionsBrowser.js";
import { groupFor, renderScopeList, rowNames } from "./DefinitionsBrowser.test-support.js";

describe("the scope groups", () => {
  it("names all three in the daemon's resolution order", () => {
    const list = renderScopeList(<DefinitionsBrowser definitions={[]} />);
    expect(
      [...list.querySelectorAll(".meridian-workflow__scope-heading")].map(
        (heading) => heading.textContent,
      ),
    ).toStrictEqual([...WORKFLOW_DEFINITION_SCOPES]);
  });

  it("files each definition under its own scope and under no other", () => {
    const list = renderScopeList(
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
    const list = renderScopeList(<DefinitionsBrowser definitions={[]} />);
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
    const list = renderScopeList(
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
    const list = renderScopeList(
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
    const list = renderScopeList(
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
    const list = renderScopeList(
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
    const list = renderScopeList(
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
    const list = renderScopeList(<DefinitionsBrowser definitions={[]} />);
    expect(groupFor(list, "project").querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("says the read is still arriving for a scope whose page is in flight", () => {
    const list = renderScopeList(
      <DefinitionsBrowser definitions={[]} pendingScopes={["project"]} />,
    );
    expect(groupFor(list, "project").querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    // Negative control on the same render: a scope that is NOT pending still reads
    // as empty, so the two arms are told apart by the flag and not by the component
    // having one shape.
    expect(groupFor(list, "session").querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});
