// The refusal grammar: three shapes, one contract. `RefusalProps` is a `Pick` of
// `lib/refusal.ts`'s `Refusal`, so a refusal from `refuse()` reaches each renderer without
// translation, and its code and message both reach the screen.

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

/** The three shapes, so the contract below is asserted against all of them. */
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
});
