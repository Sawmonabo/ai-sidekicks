// One notice, driven by shape rather than by state.
//
// The set's own test proves that a surface owes a notice per reading it holds; this
// proves the thing that moved out of it — which primitive each of the four shapes
// reaches the screen through, and that the component reads the SHAPE and never the
// state a second time.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReadingNotice } from "./ReadingNotice.js";
import { readingNoticeFor, type PartialReadNotice } from "./partial-read.js";
import { PARSE_REFUSAL } from "./partial-read.test-support.js";

function renderNotice(notice: PartialReadNotice): HTMLElement {
  return render(<ReadingNotice notice={notice} />).container;
}

describe("ReadingNotice — the shape is the instruction", () => {
  it("renders nothing at all for the complete shape", () => {
    expect(renderNotice({ shape: "none" }).innerHTML).toBe("");
  });

  it("renders a read in flight as rule 8's absence and not as prose", () => {
    const container = renderNotice({ shape: "reading", title: "Reading the queue." });
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(container.querySelector(".meridian-partial-read")).toBeNull();
  });

  it("leads a counted sentence with the derived figure and never a wire one", () => {
    // Rule 4: the console counted these, so the count must not wear the wire
    // signature. The refusal beneath it still does, which is why the assertion is
    // scoped to the copy line.
    const copy = renderNotice({
      shape: "counted-sentence",
      figure: "3",
      copy: "deliveries could not be read.",
      refusal: PARSE_REFUSAL,
    }).querySelector(".meridian-partial-read__copy");
    expect(copy?.querySelector(".meridian-figure--derived")?.textContent).toBe("3");
    expect(copy?.querySelector(".meridian-figure--wire")).toBeNull();
  });

  it("leads a whole-sentence shape with no figure at all", () => {
    const copy = renderNotice({
      shape: "sentence",
      copy: "Some of what arrived could not be read.",
      refusal: undefined,
    }).querySelector(".meridian-partial-read__copy");
    expect(copy?.querySelector(".meridian-figure--derived")).toBeNull();
    expect(copy?.textContent).toBe("Some of what arrived could not be read.");
  });

  it("carries the cause through the refusal primitive, paraphrasing none of it", () => {
    const container = renderNotice({
      shape: "sentence",
      copy: "The read of the queue was refused.",
      refusal: PARSE_REFUSAL,
    });
    expect(container.querySelector(".meridian-refusal .meridian-figure--wire")?.textContent).toBe(
      PARSE_REFUSAL.code,
    );
    expect(container.textContent).toContain(PARSE_REFUSAL.detail);
  });

  it("renders no refusal where the shape carries none", () => {
    expect(
      renderNotice({
        shape: "sentence",
        copy: "The list was cut.",
        refusal: undefined,
      }).querySelector(".meridian-refusal"),
    ).toBeNull();
  });

  it("negative control: the queries above find what is really there", () => {
    // Without this every `toBeNull` would also be satisfied by a selector that
    // matched nothing anywhere, which would make each arm look clean including one
    // that rendered the wrong primitive.
    const container = renderNotice(readingNoticeFor({ kind: "cut", servedCount: 12 }, "the queue"));
    expect(container.querySelector(".meridian-partial-read")).not.toBeNull();
    expect(container.querySelector(".meridian-figure--derived")?.textContent).toBe("12");
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });
});
