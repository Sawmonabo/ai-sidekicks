// The refusal grammar: three shapes, one contract.
//
// The contract is the thing under test, which is why this suite sits beside the
// module that declares it rather than beside any one shape — every case below
// drives all three, and a case that drove one would say nothing about the
// agreement. `RefusalProps` is a `Pick` of
// `core/refusal.ts`'s `ConsoleRefusal`, so a refusal built by `refuse()` reaches
// every one of the three renderers without a translation step — and the test drives
// exactly that, because a props shape that merely HAPPENS to have the same two
// field names would pass a per-component test and fail the moment core renamed one.
//
// The rest is rule 9's asymmetry, which is easy to lose in a redesign: the code is
// mono because it is a wire string, and the message is NOT, because a paragraph set
// in mono is a paragraph nobody reads. Both are rendered exactly as sent.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { InlineRefusal } from "./InlineRefusal.js";
import { RefusalBanner } from "./RefusalBanner.js";
import { RefusalCard } from "./RefusalCard.js";

/** A refusal built the way every producer in the console is required to build one. */
const REFUSAL = refuse(
  "persistence",
  "persistence.quota_exceeded",
  "  The window's storage partition is full. Close a session to free space.  ",
);

/** The three shapes, so each property below is asserted against all of them. */
const SHAPES = [
  ["inline", InlineRefusal],
  ["card", RefusalCard],
  ["banner", RefusalBanner],
] as const;

function renderShape(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const shape = container.firstElementChild;
  if (!(shape instanceof HTMLElement)) {
    throw new Error("Refusal rendered no element");
  }
  return shape;
}

describe("one refusal value reaches all three renderings untranslated", () => {
  it.each(SHAPES)("%s consumes a ConsoleRefusal by spread", (name, Shape) => {
    // The adoption proof: no field mapping, no adapter, no second vocabulary. If
    // `RefusalProps` re-declared its own shape, this spread would be the place the
    // two drifted apart.
    const shape = renderShape(<Shape {...REFUSAL} />);
    expect(shape.className).toContain(`meridian-refusal--${name}`);
    expect(shape.textContent).toContain(REFUSAL.code);
    expect(shape.textContent).toContain(REFUSAL.detail);
  });

  it.each(SHAPES)("%s puts the code in mono and leaves the message out of it", (_name, Shape) => {
    const shape = renderShape(<Shape {...REFUSAL} />);

    const codeFigure = shape.querySelector(".meridian-figure--wire");
    expect(codeFigure?.textContent).toBe(REFUSAL.code);

    const message = shape.querySelector(".meridian-refusal__message");
    expect(message?.textContent).toBe(REFUSAL.detail);
    // The control for the asymmetry: if the message were wrapped in a `WireFigure`
    // too, it would answer the mono selector — so requiring it not to is what
    // catches a redesign that set the whole card in mono.
    expect(message?.classList.contains("meridian-figure--wire")).toBe(false);
  });

  it.each(SHAPES)("%s renders the daemon's message verbatim", (_name, Shape) => {
    const message = renderShape(<Shape {...REFUSAL} />).querySelector(".meridian-refusal__message");
    expect(message?.textContent).toBe(REFUSAL.detail);
    // Trimming, truncating, and appending a console-authored sentence are the three
    // paraphrases rule 9 forbids; each produces a different string.
    expect(message?.textContent).not.toBe(REFUSAL.detail.trim());
    expect(message?.textContent).not.toContain("Try again");
  });

  it.each(SHAPES)("%s offers the next move as a slot rather than deriving one", (_name, Shape) => {
    const withAction = renderShape(
      <Shape {...REFUSAL} action={<button type="button">Free space</button>} />,
    );
    expect(withAction.querySelector(".meridian-refusal__action button")?.textContent).toBe(
      "Free space",
    );
    // No action supplied means no action rendered — the renderer never computes a
    // remedy of its own, because it never computes eligibility.
    expect(
      renderShape(<Shape {...REFUSAL} />).querySelector(".meridian-refusal__action"),
    ).toBeNull();
  });
});

describe("the shapes announce themselves without talking over the message", () => {
  it("announces the inline shape politely and leaves the banner to the announcer", () => {
    expect(renderShape(<InlineRefusal {...REFUSAL} />).getAttribute("role")).toBe("status");

    // The frame announces every banner raise through the one live announcer, so
    // the banner itself is a plain group: a second live region — inserted already
    // carrying its text, which most screen readers never read — would at best
    // double-read the sentence. `role="status"` implies a live region on its own,
    // so the role is the control here, not only the attribute.
    const banner = renderShape(<RefusalBanner {...REFUSAL} />);
    expect(banner.getAttribute("role")).toBe("group");
    expect(banner.getAttribute("aria-live")).toBeNull();
  });

  it("leaves the ledger card out of the live regions", () => {
    // A card lands in the ledger with everything else that happened; the feed
    // already announces its own rows, so a second live region would double-read it.
    const card = renderShape(<RefusalCard {...REFUSAL} />);
    expect(card.getAttribute("role")).toBeNull();
    expect(card.getAttribute("aria-live")).toBeNull();
  });
});
