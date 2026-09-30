// The three outcomes are three decisions: an undeclared tool kind draws nothing, a supplied
// renderer draws its own body and none of the badge's, and an unrecognized value draws the
// explicit unrecognized badge.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolKindBadge } from "./ToolKindBadge.js";
import { type ToolKindReading } from "./tool-kinds.js";

function renderBadge(
  reading: ToolKindReading | undefined,
  body?: (props: { reading: ToolKindReading }) => React.ReactNode,
): HTMLElement {
  const { container } = render(<ToolKindBadge body={body} reading={reading} />);
  return container;
}

describe("the tool kind badge", () => {
  it("draws nothing at all for a row declaring no tool kind", () => {
    expect(renderBadge(undefined).innerHTML).toBe("");
  });

  it("draws the tool kind a row declared", () => {
    const container = renderBadge({
      kind: "declared",
      toolKind: "command-output",
      serverLabel: undefined,
      argumentSummary: [],
    });
    expect(container.textContent).toContain("command-output");
  });

  it("draws the MCP server badge and the typed argument summary", () => {
    const container = renderBadge({
      kind: "declared",
      toolKind: "mcp",
      serverLabel: "sentry",
      argumentSummary: ["issueId: PROJ-4", "limit: 20"],
    });
    expect(container.textContent).toContain("mcp");
    expect(container.textContent).toContain("sentry");
    expect(container.textContent).toContain("issueId: PROJ-4");
    expect(container.textContent).toContain("limit: 20");
  });

  it("draws no server figure for a declaration that names none", () => {
    // A badge that always drew the server figure would print an empty one on every non-MCP row.
    const container = renderBadge({
      kind: "declared",
      toolKind: "file-edit",
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

  it("hands a supplied renderer the reading and draws none of the badge", () => {
    const container = renderBadge(
      { kind: "declared", toolKind: "mcp", serverLabel: "sentry", argumentSummary: [] },
      ({ reading }) => <output data-owner-body="yes">{reading.kind}</output>,
    );
    expect(container.querySelector("[data-owner-body='yes']")?.textContent).toBe("declared");
    expect(container.querySelector(".meridian-tool-kind-badge")).toBeNull();
  });

  it("does not reach a supplied renderer when the row declared nothing", () => {
    // A renderer asked to draw a treatment for a row with no declaration would have to invent one.
    let bodyCalls = 0;
    renderBadge(undefined, () => {
      bodyCalls += 1;
      return null;
    });
    expect(bodyCalls).toBe(0);
  });
});
