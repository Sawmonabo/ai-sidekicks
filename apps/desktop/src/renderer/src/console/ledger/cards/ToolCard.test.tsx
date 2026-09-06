// One line until opened — and the error that is never hidden inside the closed line.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TOOL_SUMMARY_MAX_CHARACTERS } from "./card-bounds.js";
import { FootnoteRegistry } from "./markdown/index.js";
import { sampleRunRow } from "./row-samples.test-support.js";
import { ToolCard, clampSummary } from "./ToolCard.js";

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
    <ToolCard
      row={sampleRunRow({
        type: overrides.type ?? "tool.invoked",
        ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
        ...(overrides.payload === undefined ? {} : { payload: overrides.payload }),
      })}
      participantHue={undefined}
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
  it("renders the tool's name wire-verbatim beside its summary", () => {
    const container = renderToolCard({
      payload: { toolName: "Bash" },
      summary: "Ran the test suite.",
    });
    expect(container.querySelector(".meridian-tool-card__name")?.textContent).toBe("Bash");
    expect(container.textContent).toContain("Ran the test suite.");
  });

  it("names an absent tool name as absent rather than as unknown", () => {
    const container = renderToolCard({ payload: {} });
    expect(container.querySelector(".meridian-tool-card__name--absent")).not.toBeNull();
    expect(container.textContent).not.toContain("unknown");
  });

  it("renders no body", () => {
    const container = renderToolCard({ payload: { toolName: "Bash" } });
    expect(container.querySelector(".meridian-machine-body")).toBeNull();
    expect(container.querySelector(".meridian-ansi")).toBeNull();
  });

  it("still carries the error mark on the header", () => {
    // The rule this card exists to keep: a failure is visible to a reader scanning a
    // log of forty tool calls without opening any of them.
    const container = renderToolCard({ type: "tool.error", density: "collapsed" });
    expect(container.textContent).toContain("Error");
    expect(container.querySelector(".meridian-chip--failure")).not.toBeNull();
  });

  it("negative control: an ordinary result takes neither hue", () => {
    // Without this, a card that coloured every chip would pass the case above while
    // making the two-hue rule meaningless.
    const container = renderToolCard({ type: "tool.result" });
    expect(container.textContent).toContain("Ok");
    expect(container.querySelector(".meridian-chip--failure")).toBeNull();
  });
});

describe("an opened tool row", () => {
  it("renders the body region", () => {
    const container = renderToolCard({ density: "expanded", payload: { toolName: "Bash" } });
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("renders a result body as prose, which is what the wire leaves undeclared", () => {
    // A tool result carries no content type — the tool payload has no member for one —
    // so nothing on the wire says this is terminal output. Rendering every result
    // through the ANSI renderer put an MCP reply, a web-search answer, and every other
    // ordinary textual result in a raw block with its markdown showing.
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

  it("renders an error body the same way", () => {
    // The two differ in the header's mark, not in what the body is: an error result is
    // a tool's message about what went wrong, and nothing declares that one ANSI
    // either.
    const container = renderToolCard({
      type: "tool.error",
      density: "expanded",
      payload: { toolName: "search" },
      body: "The query was `rejected`.",
    });

    expect(container.querySelector("code")?.textContent).toBe("rejected");
    expect(container.querySelector(".meridian-ansi")).toBeNull();
  });

  it("negative control: the prose renderer really is the one being reached", () => {
    // Without this the two cases above would pass over a body that rendered as plain
    // text under any renderer at all — no heading, no emphasis, nothing to tell them
    // apart.
    const container = renderToolCard({
      type: "tool.result",
      density: "expanded",
      payload: { toolName: "search" },
      body: "Just a sentence.",
    });

    expect(container.querySelector('[role="heading"]')).toBeNull();
    expect(container.textContent).toContain("Just a sentence.");
  });

  it("reports elapsed time only when the payload carried it", () => {
    const withDuration = renderToolCard({ payload: { toolName: "Bash", durationMs: 1500 } });
    expect(withDuration.querySelector(".meridian-tool-card__elapsed")).not.toBeNull();

    const withoutDuration = renderToolCard({ payload: { toolName: "Bash" } });
    expect(withoutDuration.querySelector(".meridian-tool-card__elapsed")).toBeNull();
  });
});

describe("the disclosure control", () => {
  it("appears only where the list supplies a way to change density", () => {
    const withToggle = renderToolCard({
      onDensityToggle: () => undefined,
      payload: { toolName: "Bash" },
    });
    expect(withToggle.querySelector(".meridian-tool-card__disclosure")).not.toBeNull();

    const withoutToggle = renderToolCard({ payload: { toolName: "Bash" } });
    expect(withoutToggle.querySelector(".meridian-tool-card__disclosure")).toBeNull();
  });

  it("reports the row's own state to a screen reader", () => {
    const open = renderToolCard({ density: "expanded", onDensityToggle: () => undefined });
    expect(
      open.querySelector(".meridian-tool-card__disclosure")?.getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("clamping a row's summary to one clause", () => {
  it("leaves a short summary exactly as the wire sent it", () => {
    expect(clampSummary("Ran the test suite.")).toBe("Ran the test suite.");
  });

  it("cuts a long one at a word boundary and marks the cut", () => {
    const long = "word ".repeat(60).trimEnd();
    const clamped = clampSummary(long);
    expect(clamped.length).toBeLessThanOrEqual(TOOL_SUMMARY_MAX_CHARACTERS + 1);
    expect(clamped.endsWith("…")).toBe(true);
    expect(clamped.endsWith(" …")).toBe(false);
  });

  it("cuts at the cap where no word boundary is near it", () => {
    // A single unbroken token — a digest, a path, a base64 blob — has no space to cut
    // at, and a clamp that only cut at spaces would return the whole thing.
    const unbroken = "x".repeat(400);
    expect(clampSummary(unbroken).length).toBe(TOOL_SUMMARY_MAX_CHARACTERS + 1);
  });
});
