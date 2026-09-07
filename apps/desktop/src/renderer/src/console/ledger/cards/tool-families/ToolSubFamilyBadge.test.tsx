// The sub-family shell: what it draws, what it defers to the owner, and the one case
// where drawing nothing is the right answer.
//
// THE THREE OUTCOMES ARE THREE DIFFERENT DECISIONS and are checked apart. An
// undeclared sub-family draws nothing, because a reserved marker repeated once per
// tool row would print a paragraph of unbuilt-feature prose down a long log. A filled
// slot draws the OWNER's body and none of the shell's. And an unrecognized value
// draws the explicit unrecognized badge carrying what the daemon sent.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolSubFamilyBadge } from "./ToolSubFamilyBadge.js";
import { TOOL_SUB_FAMILY_SLOT, type ToolSubFamilyReading } from "./tool-sub-families.js";

/** The slot as it ships: contracted, and standing empty. */
const UNFILLED_SLOT = { contract: TOOL_SUB_FAMILY_SLOT, body: undefined } as const;

function renderBadge(
  reading: ToolSubFamilyReading | undefined,
  body?: (props: { reading: ToolSubFamilyReading }) => React.ReactNode,
): HTMLElement {
  const { container } = render(
    <ToolSubFamilyBadge
      slot={body === undefined ? UNFILLED_SLOT : { contract: TOOL_SUB_FAMILY_SLOT, body }}
      reading={reading}
    />,
  );
  return container;
}

describe("the tool sub-family shell", () => {
  it("draws nothing at all for a row declaring no sub-family", () => {
    expect(renderBadge(undefined).innerHTML).toBe("");
  });

  it("draws the sub-family a row declared", () => {
    const container = renderBadge({
      kind: "declared",
      subFamily: "command-output",
      serverLabel: undefined,
      argumentSummary: [],
    });
    expect(container.textContent).toContain("command-output");
  });

  it("draws the MCP server badge and the typed argument summary", () => {
    const container = renderBadge({
      kind: "declared",
      subFamily: "mcp",
      serverLabel: "sentry",
      argumentSummary: ["issueId: PROJ-4", "limit: 20"],
    });
    expect(container.textContent).toContain("mcp");
    expect(container.textContent).toContain("sentry");
    expect(container.textContent).toContain("issueId: PROJ-4");
    expect(container.textContent).toContain("limit: 20");
  });

  it("draws no server figure for a declaration that names none", () => {
    // The negative control for the case above: a shell that always drew the server
    // slot would print an empty figure on every non-MCP row.
    const container = renderBadge({
      kind: "declared",
      subFamily: "file-edit",
      serverLabel: undefined,
      argumentSummary: [],
    });
    expect(container.querySelectorAll("[title='Server']")).toHaveLength(0);
  });

  it("prints what the daemon sent for a value this build does not know", () => {
    const container = renderBadge({ kind: "unrecognized", declared: "notebook-cell" });
    expect(container.textContent).toContain("Unrecognized tool kind");
    expect(container.textContent).toContain("notebook-cell");
  });

  it("hands a filled slot to the owner and draws none of the shell", () => {
    const container = renderBadge(
      { kind: "declared", subFamily: "mcp", serverLabel: "sentry", argumentSummary: [] },
      ({ reading }) => <output data-owner-body="yes">{reading.kind}</output>,
    );
    expect(container.querySelector("[data-owner-body='yes']")?.textContent).toBe("declared");
    expect(container.querySelector(".meridian-tool-sub-family")).toBeNull();
  });

  it("does not reach the owner's body when the row declared nothing", () => {
    // Absence outranks the slot: an owner asked to render a treatment for a row with
    // no declaration would have to invent one, which is what the slot exists to stop.
    let bodyCalls = 0;
    renderBadge(undefined, () => {
      bodyCalls += 1;
      return null;
    });
    expect(bodyCalls).toBe(0);
  });
});
