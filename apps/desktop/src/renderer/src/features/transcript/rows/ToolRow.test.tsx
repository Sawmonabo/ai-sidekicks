// One line until opened — and the error that is never hidden inside the closed line.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FootnoteRegistry } from "./markdown/footnotes/footnote-registry.js";
import { sampleRunRow } from "#test/helpers/transcript-event-row-samples.js";
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
      agentHue={undefined}
      isSuperseded={false}
      density={overrides.density ?? "collapsed"}
      footnotes={new FootnoteRegistry()}
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
  it("shows a result body verbatim, every line as the program printed it", () => {
    // A tool result declares no content type, so a line like `# build` is the program's own
    // output, never a markdown heading.
    const body = "# build\n  step **one** done";
    const container = renderToolCard({
      type: "tool.result",
      density: "expanded",
      payload: { toolName: "bash" },
      body,
    });

    expect(container.querySelector(".meridian-machine-body__plain")?.textContent).toBe(body);
    expect(container.querySelector('[role="heading"]')).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector(".meridian-ansi")).toBeNull();
  });
});
