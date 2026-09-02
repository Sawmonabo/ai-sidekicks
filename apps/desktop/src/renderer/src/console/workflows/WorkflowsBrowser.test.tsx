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

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { WorkflowsBrowser } from "./WorkflowsBrowser.js";
import type { WorkflowDefinitionRow } from "./DefinitionsBrowser.js";

const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

/** The continuation token the paged case below hands back. */
const SECOND_PAGE_CURSOR = "definitions-page-2";

/** One definition, as the enumeration carries it. */
const SERVED_DEFINITION: WorkflowDefinitionRow = {
  id: "release-checklist",
  name: "Release checklist",
  scope: "session",
  scopeRef: PROBE_SESSION_ID,
  latestVersionNumber: 3,
  latestWorkflowVersionId: "release-checklist-version-3",
  contentHash: "b3:0f1e2d",
  resolvesAtThisContext: true,
  createdAt: "2026-01-01T10:00:00.000Z",
};

/** One settled page, derived from the port's own answer rather than restated. */
type SettledDefinitionPage = Awaited<ReturnType<GrowthPort["workflowDefinitionList"]>>;

/** The real port answering the enumeration one way, and nothing else changed. */
function portAnswering(page: SettledDefinitionPage): GrowthPort {
  return { ...createRefusingGrowthPort(), workflowDefinitionList: async () => page };
}

function renderBrowser(growth: GrowthPort): HTMLElement {
  return render(<WorkflowsBrowser growth={growth} sessionId={PROBE_SESSION_ID} />).container;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

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

  it("shows the rows a served page carried", async () => {
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [SERVED_DEFINITION] } }),
    );

    await settle();

    expect(container.textContent).toContain("Release checklist");
  });
});

describe("the workflows browser — the handle to the next page", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers the continuation while the daemon hands back a cursor", async () => {
    const container = renderBrowser(
      portAnswering({
        status: "served",
        value: { definitions: [SERVED_DEFINITION], nextCursor: SECOND_PAGE_CURSOR },
      }),
    );

    await settle();

    expect(container.querySelector(".meridian-definitions-continuation button")?.textContent).toBe(
      "Show more definitions",
    );
  });

  it("negative control: no cursor, no control", async () => {
    // Absent, not disabled. Without this the case above would pass over a browser that
    // offered the handle unconditionally, and pressing it would re-read one page.
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [SERVED_DEFINITION] } }),
    );

    await settle();

    expect(container.querySelector(".meridian-definitions-continuation")).toBeNull();
  });
});
