// Command output: spans built from data, and never a markup string.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ANSI_SPAN_RENDER_CAP } from "./spans.js";
import { AnsiOutput } from "./AnsiOutput.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

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
  it("markup in the output reaches the screen as characters", () => {
    // The mapper is the whole path; there is no HTML string anywhere on it, which is why
    // a tool that prints a tag prints a tag rather than creating one.
    const { container } = render(<AnsiOutput source="<img src=x>" label="Output" />, {
      wrapper: LiveAnnouncerProvider,
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x>");
  });
});

describe("folding a body with more styled runs than the card renders", () => {
  it("renders every run once the reader asks for the rest", () => {
    // The fold is recoverable: reopening the card would otherwise re-parse the same capped
    // sequence and leave the tail unreachable.
    const totalRuns = ANSI_SPAN_RENDER_CAP + RUNS_PAST_THE_CAP;
    const { container } = render(<AnsiOutput source={styledRuns(totalRuns)} label="Output" />, {
      wrapper: LiveAnnouncerProvider,
    });
    fireEvent.click(screen.getByRole("button", { name: "Show the rest" }));
    expect(renderedSpanCount(container)).toBe(totalRuns);
    expect(screen.queryByRole("button", { name: "Show the rest" })).toBeNull();
  });

  it("folds again when the body underneath changes", () => {
    // A reveal is granted for the bytes the reader asked about. A streaming body that
    // inherited it would render an unbounded span count nobody asked for.
    const first = styledRuns(ANSI_SPAN_RENDER_CAP + RUNS_PAST_THE_CAP);
    const { container, rerender } = render(<AnsiOutput source={first} label="Output" />, {
      wrapper: LiveAnnouncerProvider,
    });
    fireEvent.click(screen.getByRole("button", { name: "Show the rest" }));
    rerender(<AnsiOutput source={`${first}${styledRuns(1)}`} label="Output" />);
    expect(renderedSpanCount(container)).toBe(ANSI_SPAN_RENDER_CAP);
    expect(screen.queryByRole("button", { name: "Show the rest" })).not.toBeNull();
  });
});
