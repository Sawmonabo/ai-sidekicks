// The notice, rendered — and the one thing it must never do.
//
// The model's test proves the sentence set; this proves the box. Three claims:
// a served reading renders nothing at all, every other state renders something a
// person can see, and the cause reaches the screen through the refusal primitive
// rather than as prose this component wrote.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { PartialRead } from "./PartialRead.js";
import { READING_STATE_KINDS, type ReadingState, type ReadingStateKind } from "./partial-read.js";

const SUBJECT = "the queue";

const PARSE_REFUSAL = refuse(
  "session-queue",
  "delivery-unreadable",
  "A queue delivery did not match the registered row shape.",
);

const STATE_BY_KIND: Readonly<Record<ReadingStateKind, ReadingState>> = {
  served: { kind: "served" },
  reading: { kind: "reading" },
  refused: { kind: "refused", refusal: PARSE_REFUSAL },
  partial: { kind: "partial", unreadableCount: 3, newestRefusal: PARSE_REFUSAL },
  cut: { kind: "cut", servedCount: 12 },
};

function renderNotice(state: ReadingState): HTMLElement {
  const { container } = render(<PartialRead state={state} subject={SUBJECT} />);
  return container;
}

describe("PartialRead — a surface says less than complete, never more", () => {
  it("renders nothing for a served reading", () => {
    expect(renderNotice(STATE_BY_KIND.served).innerHTML).toBe("");
  });

  it("renders something visible for every other state", () => {
    for (const kind of READING_STATE_KINDS) {
      if (kind === "served") {
        continue;
      }
      const container = renderNotice(STATE_BY_KIND[kind]);
      expect(container.innerHTML, `the ${kind} state rendered nothing`).not.toBe("");
    }
  });

  it("negative control: the emptiness check reads the real tree", () => {
    // Without this an assertion on `innerHTML` could be satisfied by a container
    // that was never rendered into at all, which would make the clean result above
    // true of any component whatsoever.
    expect(renderNotice(STATE_BY_KIND.partial).innerHTML).toContain("meridian-partial-read");
  });
});

describe("PartialRead — what each arm puts on screen", () => {
  it("carries the refusal's code through the refusal primitive", () => {
    const container = renderNotice(STATE_BY_KIND.refused);
    const code = container.querySelector(".meridian-refusal .meridian-figure--wire");
    expect(code?.textContent).toBe(PARSE_REFUSAL.code);
    expect(container.textContent).toContain(PARSE_REFUSAL.detail);
  });

  it("carries the count as a derived figure and never as a wire one", () => {
    // Rule 4: the console counted these, so the count must not wear the wire
    // signature. The refusal beneath it still does, which is why the assertion is
    // scoped to the copy line.
    const copy = renderNotice(STATE_BY_KIND.partial).querySelector(".meridian-partial-read__copy");
    expect(copy?.querySelector(".meridian-figure--derived")?.textContent).toBe("3");
    expect(copy?.querySelector(".meridian-figure--wire")).toBeNull();
  });

  it("renders the in-flight read as the not-loaded absence and not as prose", () => {
    const container = renderNotice(STATE_BY_KIND.reading);
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    // One live region, not two: the absence carries its own `role="status"`, so the
    // prose wrapper must not be around it announcing the same sentence again.
    expect(container.querySelector(".meridian-partial-read")).toBeNull();
  });

  it("contributes one live region of its own, whichever arm it renders", () => {
    // Its own, measured by discounting the refusal primitive's: rule 9 gives a
    // refusal its region and this notice does not get to take it away. What must
    // not happen is the notice adding a SECOND region of its own beside it, which
    // is what a wrapper per arm would have produced.
    for (const kind of ["refused", "partial", "cut"] as const) {
      const container = renderNotice(STATE_BY_KIND[kind]);
      expect(
        container.querySelectorAll('[role="status"]:not(.meridian-refusal)').length,
        `${kind} regions`,
      ).toBe(1);
    }
  });

  it("renders no refusal where the state carries none", () => {
    expect(renderNotice(STATE_BY_KIND.cut).querySelector(".meridian-refusal")).toBeNull();
  });
});
