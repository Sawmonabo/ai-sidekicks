// The refusal grammar: three shapes, one contract. Every case drives all three shapes, and
// `RefusalProps` is a `Pick` of `lib/refusal.ts`'s `Refusal`, so a refusal from `refuse()` reaches
// each renderer without translation. The code is mono because it is a wire string; the message is
// not, and both render exactly as sent.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";
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
  it.each(SHAPES)("%s consumes a Refusal by spread", (name, Shape) => {
    // No field mapping or adapter: a re-declared `RefusalProps` would drift apart at this spread.
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
    // Control: a message wrapped in a `WireFigure` would answer the mono selector.
    expect(message?.classList.contains("meridian-figure--wire")).toBe(false);
  });

  it.each(SHAPES)("%s renders the daemon's message verbatim", (_name, Shape) => {
    const message = renderShape(<Shape {...REFUSAL} />).querySelector(".meridian-refusal__message");
    expect(message?.textContent).toBe(REFUSAL.detail);
    // Trimming, truncating and appending a sentence are the paraphrases the grammar forbids.
    expect(message?.textContent).not.toBe(REFUSAL.detail.trim());
    expect(message?.textContent).not.toContain("Try again");
  });

  it.each(SHAPES)("%s offers the next move as a prop rather than deriving one", (_name, Shape) => {
    const withAction = renderShape(
      <Shape {...REFUSAL} action={<button type="button">Free space</button>} />,
    );
    expect(withAction.querySelector(".meridian-refusal__action button")?.textContent).toBe(
      "Free space",
    );
    // No action supplied means none rendered; the renderer computes no remedy.
    expect(
      renderShape(<Shape {...REFUSAL} />).querySelector(".meridian-refusal__action"),
    ).toBeNull();
  });
});

describe("the shapes announce themselves without talking over the message", () => {
  it("announces the inline shape politely and leaves the banner to the announcer", () => {
    expect(renderShape(<InlineRefusal {...REFUSAL} />).getAttribute("role")).toBe("status");

    // The frame announces banner raises through the one announcer, so the banner is a plain group.
    // `role="status"` implies a live region, so the role is the control, not only the attribute.
    const banner = renderShape(<RefusalBanner {...REFUSAL} />);
    expect(banner.getAttribute("role")).toBe("group");
    expect(banner.getAttribute("aria-live")).toBeNull();
  });

  it("leaves the transcript card out of the live regions", () => {
    // A card lands in the transcript, which already announces its own rows.
    const card = renderShape(<RefusalCard {...REFUSAL} />);
    expect(card.getAttribute("role")).toBeNull();
    expect(card.getAttribute("aria-live")).toBeNull();
  });
});
