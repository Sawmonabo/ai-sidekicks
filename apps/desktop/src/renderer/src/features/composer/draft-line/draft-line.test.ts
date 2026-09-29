// The draft line's caret reading: only a collapsed caret at an edge lets an arrow recall.

import { describe, expect, it } from "vitest";

import { caretAtEnd, caretAtStart } from "./draft-line.js";

describe("the edge offsets are what let an arrow recall at all", () => {
  it("recognizes a collapsed caret at each edge", () => {
    expect(caretAtStart({ selectionStart: 0, selectionEnd: 0, textLength: 9 })).toBe(true);
    expect(caretAtEnd({ selectionStart: 9, selectionEnd: 9, textLength: 9 })).toBe(true);
  });

  it("declines a selection and a caret in the middle", () => {
    // A person selecting from the start is not at the start edge in the sense that
    // matters: ArrowUp there extends or collapses their selection.
    expect(caretAtStart({ selectionStart: 0, selectionEnd: 4, textLength: 9 })).toBe(false);
    expect(caretAtEnd({ selectionStart: 4, selectionEnd: 4, textLength: 9 })).toBe(false);
  });
});
