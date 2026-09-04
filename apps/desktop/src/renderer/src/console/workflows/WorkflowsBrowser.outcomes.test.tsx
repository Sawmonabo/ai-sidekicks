// What the surface wears for each of the enumeration's answers.
//
// The mapping is this component's whole job — one outcome in, one chrome and one set
// of groups out — so every case drives the REAL growth port and reads the rendered
// markup, rather than asserting against the props it happened to pass down.
//
// The refusal case is the one worth stating twice. A refusal attached to each group
// left every group rendering the refusal AND `No <scope> definitions` under it, which
// turns one failed read into three asserted empty results; the served-empty case
// beside it is what makes that assertion bite, because it shows those very lines are
// exactly what a real empty answer renders.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import {
  SECOND_PAGE_CURSOR,
  SERVED_DEFINITION,
  portAnswering,
  renderBrowser,
  settle,
} from "./WorkflowsBrowser.test-support.js";

function scopeHeadings(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-workflow__scope-heading")].map(
    (heading) => heading.textContent ?? "",
  );
}

/**
 * The "there is none" line each SCOPE GROUP rendered.
 *
 * Scoped to the groups rather than to the surface, because the surface also mounts the
 * reserved conversational-start slot, whose own absence is a true statement about a
 * body no plan has authored yet and has nothing to do with what the read found.
 */
function emptyGroupTitles(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-workflow__scope .meridian-nothing--empty")].map(
    (nothing) => nothing.textContent ?? "",
  );
}

/** How many groups reported that they have read only part of the enumeration. */
function unresolvedGroupCount(container: HTMLElement): number {
  return container.querySelectorAll(".meridian-workflow__scope .meridian-nothing--not-checked")
    .length;
}

describe("the workflows browser — what one outcome becomes on screen", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a refused enumeration as one refusal, with no group claiming to be empty", async () => {
    const container = renderBrowser(createRefusingGrowthPort());

    await settle();

    expect(container.textContent).toContain("wire-unregistered");
    // No groups at all. The read produced no list to group, and a group rendered under
    // a refusal asserts an answer about its scope that the daemon never gave.
    expect(scopeHeadings(container)).toStrictEqual([]);
    expect(emptyGroupTitles(container)).toStrictEqual([]);
  });

  it("renders a served empty enumeration as three named groups that say so", async () => {
    // The control that makes the case above bite: these are the very lines the old
    // mapping rendered underneath the refusal, so their absence there is a real
    // difference rather than a component that renders nothing in both states.
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [] } }),
    );

    await settle();

    expect(scopeHeadings(container)).toStrictEqual(["session", "project", "shared"]);
    expect(emptyGroupTitles(container).join(" ")).toContain("No session definitions.");
  });

  it("reads as a wait for every scope while the first page is in flight", async () => {
    // One read serves all three scopes, so a wait DOES belong to all three — which is
    // the axis on which a refusal differs, and why only one of them distributes.
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [] } }),
    );

    expect(container.querySelectorAll(".meridian-nothing--not-loaded")).toHaveLength(3);
    expect(emptyGroupTitles(container)).toStrictEqual([]);

    await settle();
  });

  it("claims no scope is empty while the daemon still holds a cursor", async () => {
    // The whole finding, end to end: the first page carries a cursor and one `session`
    // row, so `project` and `shared` have been read only in part. They said
    // `No project definitions` and `No shared definitions` anyway — a definitive result
    // about a daemon that had just said there was more to come.
    const container = renderBrowser(
      portAnswering({
        status: "served",
        value: { definitions: [SERVED_DEFINITION], nextCursor: SECOND_PAGE_CURSOR },
      }),
    );

    await settle();

    expect(container.textContent).toContain("Release checklist");
    expect(emptyGroupTitles(container)).toStrictEqual([]);
    expect(unresolvedGroupCount(container)).toBe(2);
  });

  it("negative control: the last page lets the scopes it did not fill say they are empty", async () => {
    // Without this, the case above passes for a browser that never resolves a scope at
    // all — the same conflation in the other direction, with a console that has read
    // the whole enumeration unable to report a real empty result.
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [SERVED_DEFINITION] } }),
    );

    await settle();

    expect(unresolvedGroupCount(container)).toBe(0);
    expect(emptyGroupTitles(container).join(" ")).toContain("No project definitions.");
  });

  it("shows the rows a served page carried", async () => {
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [SERVED_DEFINITION] } }),
    );

    await settle();

    expect(container.textContent).toContain("Release checklist");
  });
});
