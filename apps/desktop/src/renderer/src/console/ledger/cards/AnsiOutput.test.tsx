// Command output: spans built from data, and never a markup string.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatCount } from "../../primitives/index.js";
import { AnsiOutput } from "./AnsiOutput.js";
import { ANSI_SPAN_RENDER_CAP } from "./card-bounds.js";

const ESCAPE = String.fromCodePoint(0x1b);

/** How many styled runs past the cap the folded fixture holds. */
const RUNS_PAST_THE_CAP = 104;

/** One red run per repetition, so the run count is the repetition count. */
function styledRuns(runCount: number): string {
  return `${ESCAPE}[31ma${ESCAPE}[39m`.repeat(runCount);
}

function renderedSpanCount(container: HTMLElement): number {
  return container.querySelectorAll("pre > span").length;
}

describe("rendering ANSI output", () => {
  it("puts each styled run in its own span, in a preformatted block", () => {
    const { container } = render(
      <AnsiOutput source={`${ESCAPE}[31mfailed${ESCAPE}[39m ok`} label="Output of ls" />,
    );
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector(".meridian-ansi__fg--red")).not.toBeNull();
    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("ok");
  });

  it("names the block for a screen reader", () => {
    const { container } = render(<AnsiOutput source="plain" label="Output of ls" />);
    expect(container.querySelector("pre")?.getAttribute("aria-label")).toBe("Output of ls");
  });

  it("negative control: markup in the output reaches the screen as characters", () => {
    // The mapper is the whole path; there is no HTML string anywhere on it, which is why
    // a tool that prints a tag prints a tag rather than creating one.
    const { container } = render(<AnsiOutput source="<img src=x>" label="Output" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x>");
  });
});

describe("folding a body with more styled runs than the card renders", () => {
  it("says how much is shown, how much is not, and offers the rest", () => {
    const { container } = render(
      <AnsiOutput source={styledRuns(ANSI_SPAN_RENDER_CAP + RUNS_PAST_THE_CAP)} label="Output" />,
    );
    expect(renderedSpanCount(container)).toBe(ANSI_SPAN_RENDER_CAP);
    // Both figures in the badge's own label rather than in `detail`, which the badge
    // renders as a `title` attribute and no keyboard or touch reader ever reaches.
    const notice = container.querySelector(".meridian-nothing__badge-label");
    // Through `formatCount`, because that is the rule for a figure the console derived:
    // grouped per locale, never a bare `String()` a test could satisfy by accident.
    expect(notice?.textContent).toContain(formatCount(ANSI_SPAN_RENDER_CAP));
    expect(notice?.textContent).toContain(formatCount(RUNS_PAST_THE_CAP));
    expect(notice?.getAttribute("title")).toBeNull();
  });

  it("renders every run once the reader asks for the rest", () => {
    // The bound's rationale claims the fold is recoverable. Before this, reopening the
    // card re-parsed the same capped sequence and the tail was unreachable.
    const totalRuns = ANSI_SPAN_RENDER_CAP + RUNS_PAST_THE_CAP;
    const { container } = render(<AnsiOutput source={styledRuns(totalRuns)} label="Output" />);
    fireEvent.click(screen.getByRole("button", { name: "Show the rest" }));
    expect(renderedSpanCount(container)).toBe(totalRuns);
    expect(screen.queryByRole("button", { name: "Show the rest" })).toBeNull();
  });

  it("folds again when the body underneath changes", () => {
    // A reveal is granted for the bytes the reader asked about. A streaming body that
    // inherited it would render an unbounded span count nobody asked for.
    const first = styledRuns(ANSI_SPAN_RENDER_CAP + RUNS_PAST_THE_CAP);
    const { container, rerender } = render(<AnsiOutput source={first} label="Output" />);
    fireEvent.click(screen.getByRole("button", { name: "Show the rest" }));
    rerender(<AnsiOutput source={`${first}${styledRuns(1)}`} label="Output" />);
    expect(renderedSpanCount(container)).toBe(ANSI_SPAN_RENDER_CAP);
    expect(screen.queryByRole("button", { name: "Show the rest" })).not.toBeNull();
  });

  it("negative control: a body under the cap renders no notice and no control", () => {
    // Without this, a component that always rendered the notice would pass every
    // assertion above.
    const { container } = render(<AnsiOutput source={styledRuns(3)} label="Output" />);
    expect(renderedSpanCount(container)).toBe(3);
    expect(container.querySelector(".meridian-nothing")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show the rest" })).toBeNull();
  });
});
