// One line until opened — and the error that is never hidden inside the closed line.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FootnoteRegistry } from "./markdown/footnotes/footnote-registry.js";
import { sampleRunRow } from "@test/helpers/timeline-row-samples.js";
import { ToolRow } from "./ToolRow.js";

function renderToolCard(
  overrides: {
    readonly type?: string;
    readonly summary?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly density?: "collapsed" | "expanded";
    readonly onDensityToggle?: () => void;
    readonly body?: string;
  } = {},
): HTMLElement {
  const { container } = render(
    <ToolRow
      row={sampleRunRow({
        type: overrides.type ?? "tool.invoked",
        ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
        ...(overrides.payload === undefined ? {} : { payload: overrides.payload }),
      })}
      actorHue={undefined}
      isSuperseded={false}
      density={overrides.density ?? "collapsed"}
      footnotes={new FootnoteRegistry()}
      toolKindRenderer={undefined}
      {...(overrides.body === undefined
        ? {}
        : { content: { status: "available", body: overrides.body } as const })}
      {...(overrides.onDensityToggle === undefined
        ? {}
        : { onDensityToggle: overrides.onDensityToggle })}
    />,
  );
  return container;
}

describe("a collapsed tool row", () => {
  it("still carries the error mark on the header", () => {
    // The rule this card exists to keep: a failure is visible to a reader scanning a
    // log of forty tool calls without opening any of them.
    const container = renderToolCard({ type: "tool.error", density: "collapsed" });
    expect(container.textContent).toContain("Error");
    expect(container.querySelector(".meridian-chip--failure")).not.toBeNull();
  });
});

describe("an opened tool row", () => {
  it("renders a result body as prose, which is what the wire leaves undeclared", () => {
    // A tool result carries no content type, so nothing on the wire says it is terminal output;
    // the ANSI renderer would show an MCP reply or web-search answer in a raw block with its
    // markdown visible.
    const container = renderToolCard({
      type: "tool.result",
      density: "expanded",
      payload: { toolName: "search" },
      body: "## Findings\n\nOne **strong** match.",
    });

    const heading = container.querySelector('[role="heading"]');
    expect(heading?.textContent).toBe("Findings");
    expect(heading?.getAttribute("data-depth")).toBe("2");
    expect(container.querySelector("strong")?.textContent).toBe("strong");
    expect(container.querySelector(".meridian-ansi")).toBeNull();
  });
});
