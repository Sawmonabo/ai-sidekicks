import { describe, expect, it } from "vitest";

import { ANSI_SPAN_RENDER_CAP } from "./ansi-spans.js";
import { parseAnsiSpans } from "./ansi-spans.js";

/** Built from its code point: a raw escape in source is invisible in a diff. */
const ESCAPE = String.fromCodePoint(0x1b);

/** One styled run per repetition, each with content, so a run count is a span count. */
function styledRuns(runCount: number): string {
  return `${ESCAPE}[31ma${ESCAPE}[39m`.repeat(runCount);
}

describe("parsing ANSI output", () => {
  it("keeps the text and drops the escape sequences", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[31mfailed${ESCAPE}[39m`);
    expect(spans.map((span) => span.text).join("")).toBe("failed");
    expect(spans.map((span) => span.text).join("")).not.toContain(ESCAPE);
  });

  it("bounds what it renders and says how much it left out", () => {
    const { spans, elidedSpanCount } = parseAnsiSpans(styledRuns(ANSI_SPAN_RENDER_CAP + 40));
    expect(spans.length).toBe(ANSI_SPAN_RENDER_CAP);
    // The exact figure: the card prints it, and the entry total would also be positive.
    expect(elidedSpanCount).toBe(40);
  });

  it("takes the cap from its caller, so a fold can be lifted for one block", () => {
    // `AnsiOutput` re-parses the same source under a wider cap when the reader asks for the
    // rest.
    const source = styledRuns(10);
    const folded = parseAnsiSpans(source, 4);
    expect(folded.spans).toHaveLength(4);
    expect(folded.elidedSpanCount).toBe(6);

    const lifted = parseAnsiSpans(source, folded.spans.length + folded.elidedSpanCount);
    expect(lifted.spans).toHaveLength(10);
    expect(lifted.elidedSpanCount).toBe(0);
  });
});
