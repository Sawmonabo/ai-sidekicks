// The deck as a place a dragged SIDEBAR ROW can land.
//
// Split from `Deck.test.tsx`, which is about the deck's own frame — its mount door,
// its panes, its keyboard paths. This file asks one question about the deck's part in
// somebody else's gesture: is the board registered as a drop target at all, and is it
// registered on the element that is there whether or not the deck holds a pane.
//
// THE LIBRARY IS THE INSTRUMENT, and it has to be. `dropTargetForElements` stamps
// `data-drop-target-for-element` on whatever it registers and removes it on cleanup,
// so the attribute is the library's own record of the registration rather than a
// marker this console writes for a test to read — which is the difference between
// asserting that the deck is a drop target and asserting that somebody remembered to
// say so. The gesture itself cannot be driven in this tier: jsdom implements neither
// `DragEvent` nor `DataTransfer`, so what a settled drop DOES is asserted on the
// settle function, in `sidebar/drag/row-drag.test.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../../core/index.js";
import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { FIRST_RUN_SCENARIO } from "../../bridge/scenarios/first-run.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { ConsolePaneRegistry, type ConsolePaneContext } from "../../seats/index.js";
import { Deck } from "./Deck.js";
import { DeckLayout } from "./deck-layout.js";
import type { DeckPane } from "./deck-model.js";

/** What the library stamps on an element it has registered as a drop target. */
const DROP_TARGET_ATTRIBUTE = "data-drop-target-for-element";

/**
 * The pane context, cast — the trade `Deck.test.tsx` states and makes for the same
 * reason: no body here reads it, so building four stores to satisfy it would make the
 * setup the subject.
 */
function paneContextFor(pane: DeckPane): ConsolePaneContext {
  return {
    kind: pane.kind,
    entity: pane.entity,
    paneId: pane.paneId,
  } as unknown as ConsolePaneContext;
}

/** A registry whose one body says which pane it is, and nothing else. */
function registryWithTimeline(): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  registry.register({
    kind: "timeline",
    owner: "deck-row-drop-test",
    render: (context) => <p data-pane={context.paneId}>timeline body</p>,
  });
  return registry;
}

/** The deck under the two providers the frame mounts above every surface. */
function renderDeck(layout: DeckLayout): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: FIRST_RUN_SCENARIO })}>
      <LiveAnnouncerProvider>
        <Deck layout={layout} registry={registryWithTimeline()} paneContextFor={paneContextFor} />
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  );
  const deck = container.querySelector(".meridian-deck");
  if (!(deck instanceof HTMLElement)) {
    throw new Error("Deck rendered no deck element");
  }
  return deck;
}

describe("the deck as a row's drop target", () => {
  it("registers its own root, so a row released over the board lands somewhere", () => {
    // The defect this closes was on the other side of the seam: the sidebar's monitor
    // committed every drop of a row payload, wherever the gesture ended, because
    // nothing on the deck said where a drop counted. The monitor asks the drop targets
    // now, and this is the target it asks about.
    const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
    layout.open({ kind: "timeline", entity: undefined });

    expect(renderDeck(layout).hasAttribute(DROP_TARGET_ATTRIBUTE)).toBe(true);
  });

  it("registers it on an EMPTY deck too, which is the deck a row is dragged onto first", () => {
    // The load-bearing half. The resizable group carries the deck's measured element
    // and is not rendered at all while nothing is open, so a target bound there would
    // have refused precisely the gesture the empty deck's own copy invites — "Open one
    // from the sidebar".
    const deck = renderDeck(new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP }));

    expect(deck.textContent).toContain("No panes are open.");
    expect(deck.hasAttribute(DROP_TARGET_ATTRIBUTE)).toBe(true);
  });

  it("negative control: an element the deck did not register carries no such attribute", () => {
    // Without this, the two cases above would pass over an attribute jsdom hands to
    // everything, or over a reading that never consulted the element at all.
    const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
    layout.open({ kind: "timeline", entity: undefined });
    const deck = renderDeck(layout);
    const paneBody = deck.querySelector("p");

    expect(paneBody).not.toBeNull();
    expect(paneBody?.hasAttribute(DROP_TARGET_ATTRIBUTE)).toBe(false);
  });
});
