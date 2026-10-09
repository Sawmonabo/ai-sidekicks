// The Runs strip's `Next waiting (N)` drawn in Chromium: its count sits in the label's one run of
// text, so no character of it stands apart from the next by the button's flex gap. A label split
// into words and a figure becomes several flex items inside the button, and the gap opens between
// `(` and the count; that split is the negative control, drawn beside it.

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { RunsStrip } from "#renderer/features/workflows/components/RunsStrip.js";

afterEach(() => {
  cleanup();
});

/**
 * How far apart `before` and `after` are drawn, in CSS px, where `after` is the first character
 * following the first `before` in `element`'s text: the space between the one's right edge and the
 * other's left edge.
 */
function drawnSpaceBetween(element: Element, before: string, after: string): number {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const characters: { readonly node: Text; readonly offset: number }[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    for (let offset = 0; offset < text.data.length; offset += 1) {
      characters.push({ node: text, offset });
    }
  }
  const index = characters.findIndex(({ node, offset }) => node.data[offset] === before);
  const first = characters[index];
  const second = characters[index + 1];
  if (first === undefined || second === undefined || second.node.data[second.offset] !== after) {
    throw new Error(`"${before}" is not followed by "${after}" in ${element.textContent ?? ""}`);
  }
  return boxOf(second).left - boxOf(first).right;
}

function boxOf(character: { readonly node: Text; readonly offset: number }): DOMRect {
  const range = character.node.ownerDocument.createRange();
  range.setStart(character.node, character.offset);
  range.setEnd(character.node, character.offset + 1);
  return range.getBoundingClientRect();
}

it("draws Next waiting (2) as one run of text, the count against its parenthesis", () => {
  installMeridianTokens(document);
  const { container } = render(
    <>
      <RunsStrip
        nextWaiting={{ kind: "loaded", workflowRunId: "run-2", count: 2 }}
        readAttentionAgain={() => undefined}
        isRunPageOpen={false}
        onOpenRun={() => undefined}
        feedState={{ kind: "open", pause: undefined }}
        pauseAct={{ kind: "idle" }}
        onSetPaused={() => undefined}
      />
      {/* The split label the button once drew, in the same treatment. */}
      <button
        type="button"
        className="meridian-action-button meridian-action-button--small meridian-action-button--outline"
        data-split-label
      >
        Next waiting (<span>2</span>)
      </button>
    </>,
  );
  const label = container.querySelector(".meridian-workflows-strip button");
  const split = container.querySelector("[data-split-label]");
  if (label === null || split === null) {
    throw new Error("the strip drew no Next waiting button");
  }

  expect(label.textContent).toBe("Next waiting (2)");
  expect(drawnSpaceBetween(label, "(", "2")).toBeLessThan(0.5);
  expect(drawnSpaceBetween(split, "(", "2")).toBeGreaterThan(1);
});
