// A call with a body folds and opens on its chevron; one without a body has nothing to fold. The
// error is never hidden inside a folded line.

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { FootnoteRegistry } from "./markdown/footnotes/registry.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { sampleRunRow } from "#test/helpers/transcript/event-row-samples.js";
import { ToolRow } from "./ToolRow.js";

function renderToolCard(
  overrides: {
    readonly type?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly density?: "collapsed" | "expanded";
    readonly onDensityToggle?: (control: HTMLElement) => void;
    readonly body?: string;
  } = {},
): HTMLElement {
  const { container } = render(
    <ToolRow
      row={sampleRunRow({
        type: overrides.type ?? "tool.invoked",
        ...(overrides.payload === undefined ? {} : { payload: overrides.payload }),
        ...(overrides.body === undefined
          ? {}
          : { content: { status: "available", body: overrides.body } as const }),
      })}
      agentHue={undefined}
      isSuperseded={false}
      density={overrides.density ?? "collapsed"}
      footnotes={new FootnoteRegistry()}
      {...(overrides.onDensityToggle === undefined
        ? {}
        : { onDensityToggle: overrides.onDensityToggle })}
    />,
    { wrapper: liveBridgeWrapper() },
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
      payload: { toolName: "bash", contentLength: body.length },
      body,
    });

    expect(container.querySelector(".meridian-machine-body__plain")?.textContent).toBe(body);
    expect(container.querySelector('[role="heading"]')).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
  });
});

/** A tool card whose fold the harness holds, as the list does, so a press repaints it. */
function FoldingToolCard(props: { readonly body: string }): React.JSX.Element {
  const [density, setDensity] = useState<"collapsed" | "expanded">("expanded");
  return (
    <ToolRow
      row={sampleRunRow({
        type: "tool.result",
        payload: { toolName: "bash", contentLength: props.body.length },
        content: { status: "available", body: props.body },
      })}
      agentHue={undefined}
      isSuperseded={false}
      density={density}
      footnotes={new FootnoteRegistry()}
      onDensityToggle={() => {
        setDensity((current) => (current === "expanded" ? "collapsed" : "expanded"));
      }}
    />
  );
}

describe("a call's chevron", () => {
  it("folds a call with a multi-line body to its line, keeping the tool's name in view", () => {
    const body = "step one\nstep two\nstep three";
    const { container } = render(<FoldingToolCard body={body} />, {
      wrapper: liveBridgeWrapper(),
    });
    // Named by the tool's name beside it, and a native button in the tab order, so Enter and
    // Space press it the way they press any button.
    const chevron = screen.getByRole("button", { name: "bash" });
    expect(chevron.tagName).toBe("BUTTON");
    expect(chevron.tabIndex).toBe(0);
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".meridian-machine-body__plain")?.textContent).toBe(body);

    fireEvent.click(chevron);

    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".meridian-machine-body__plain")).toBeNull();
    expect(container.querySelector(".meridian-tool-card__name")?.textContent).toBe("bash");
  });

  it("is absent from a call with no body, leaving no tab stop", () => {
    const container = renderToolCard({
      type: "tool.invoked",
      density: "expanded",
      payload: { toolName: "bash" },
      onDensityToggle: () => undefined,
    });
    expect(container.querySelector("button, [tabindex]")).toBeNull();
  });
});
