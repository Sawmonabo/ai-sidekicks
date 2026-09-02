// The deck: one body per kind, one pane per entity, and the door that enforces both.
//
// The negative control this file exists for is the SECOND MOUNT DOOR. A registry
// that quietly replaced a claimed kind would look identical on screen — the pane
// would render, just somebody else's body — and which one you got would depend on
// module import order, which nothing in a test or a review can see.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../../core/index.js";
import { ConsolePaneRegistry, type ConsolePaneContext } from "../seats/index.js";
import { Deck } from "./Deck.js";
import { DeckLayout } from "./deck-layout.js";
import type { DeckPane } from "./deck-model.js";

function emptyLayout(): DeckLayout {
  return new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
}

/**
 * The pane context, cast.
 *
 * Every body below renders a marker string and reads nothing from the context —
 * the subject is the deck's frame, not a pane's content — so constructing four
 * stores (one of which opens a database) to satisfy fields nothing reads would make
 * the setup the subject. `TimelinePane.test.tsx` makes the same trade for the same
 * reason.
 */
function paneContextFor(pane: DeckPane): ConsolePaneContext {
  return {
    kind: pane.kind,
    entity: pane.entity,
    paneId: pane.paneId,
  } as unknown as ConsolePaneContext;
}

/** A registry whose bodies say which pane they are, and nothing else. */
function registryWith(
  ...descriptors: readonly { kind: DeckPane["kind"]; owner?: string; openInWindow?: boolean }[]
): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  for (const descriptor of descriptors) {
    registry.register({
      kind: descriptor.kind,
      owner: descriptor.owner ?? "deck-test",
      openInWindow: descriptor.openInWindow ?? false,
      render: (context) => <p data-pane={context.paneId}>{descriptor.kind} body</p>,
    });
  }
  return registry;
}

function renderDeck(layout: DeckLayout, registry: ConsolePaneRegistry): HTMLElement {
  const { container } = render(
    <Deck layout={layout} registry={registry} paneContextFor={paneContextFor} />,
  );
  const deck = container.querySelector(".meridian-deck");
  if (!(deck instanceof HTMLElement)) {
    throw new Error("Deck rendered no deck element");
  }
  return deck;
}

describe("the deck's mount door", () => {
  it("refuses a second owner claiming a kind rather than replacing the first", () => {
    const registry = registryWith({ kind: "timeline", owner: "ledger" });
    expect(() =>
      registry.register({
        kind: "timeline",
        owner: "somebody-else",
        openInWindow: false,
        render: () => null,
      }),
    ).toThrow();
  });

  it("negative control: the SAME owner re-registering replaces, so a hot reload works", () => {
    // Without this, the case above would pass over a registry that refused every
    // second registration, which would make reloading a module fatal.
    const registry = registryWith({ kind: "timeline", owner: "ledger" });
    expect(() =>
      registry.register({
        kind: "timeline",
        owner: "ledger",
        openInWindow: false,
        render: () => null,
      }),
    ).not.toThrow();
  });

  it("names the kind rather than drawing an empty rectangle when nothing claims it", () => {
    const layout = emptyLayout();
    layout.open({ kind: "artifact", entity: undefined });
    const deck = renderDeck(layout, registryWith());
    expect(deck.textContent).toContain("This kind of pane has not been built yet.");
    expect(deck.textContent).toContain("artifact");
  });
});

describe("the deck's panes", () => {
  it("mounts one body per open pane, in the layout's order", () => {
    const layout = emptyLayout();
    layout.open({ kind: "timeline", entity: undefined });
    layout.open({ kind: "runs", entity: undefined });
    const deck = renderDeck(layout, registryWith({ kind: "timeline" }, { kind: "runs" }));
    expect([...deck.querySelectorAll("p")].map((body) => body.textContent)).toStrictEqual([
      "timeline body",
      "runs body",
    ]);
  });

  it("focuses the pane that already shows an entity instead of opening a second", () => {
    const layout = emptyLayout();
    const first = layout.open({ kind: "inspector", entity: { kind: "run", id: "run-01" } });
    const second = layout.open({ kind: "inspector", entity: { kind: "run", id: "run-01" } });
    const deck = renderDeck(layout, registryWith({ kind: "inspector" }));
    expect(second).toBe(first);
    expect(deck.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
  });

  it("puts a separator between panes and none before the first", () => {
    const layout = emptyLayout();
    layout.open({ kind: "timeline", entity: undefined });
    layout.open({ kind: "runs", entity: undefined });
    layout.open({ kind: "approvals", entity: undefined });
    const deck = renderDeck(
      layout,
      registryWith({ kind: "timeline" }, { kind: "runs" }, { kind: "approvals" }),
    );
    const separators = deck.querySelectorAll('[role="separator"]');
    expect(separators).toHaveLength(2);
    expect(separators[0]?.getAttribute("aria-valuemax")).toBe("1000");
  });

  it("says the deck is empty rather than rendering an unexplained blank", () => {
    const deck = renderDeck(emptyLayout(), registryWith({ kind: "timeline" }));
    expect(deck.textContent).toContain("No panes are open.");
  });

  it("renders what a restore refused, inside the deck the refusal is about", () => {
    const layout = emptyLayout();
    const report = layout.restore({ $deck: { version: 99 } });
    const { container } = render(
      <Deck
        layout={layout}
        registry={registryWith({ kind: "timeline" })}
        paneContextFor={paneContextFor}
        restoreRefusals={report.refusals}
      />,
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "written by a different version",
    );
  });
});

describe("the deck's keyboard paths", () => {
  it("moves focus with Alt+Arrow and moves the PANE with Alt+Shift+Arrow", () => {
    const layout = emptyLayout();
    const first = layout.open({ kind: "timeline", entity: undefined });
    const second = layout.open({ kind: "runs", entity: undefined });
    const deck = renderDeck(layout, registryWith({ kind: "timeline" }, { kind: "runs" }));

    focus(layout, first);
    press(deck, { key: "ArrowRight", altKey: true });
    expect(layout.snapshot().focusedPaneId).toBe(second);

    focus(layout, first);
    press(deck, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([second, first]);
  });

  it("closes the focused pane with Alt+Backspace", () => {
    const layout = emptyLayout();
    const only = layout.open({ kind: "timeline", entity: undefined });
    const deck = renderDeck(layout, registryWith({ kind: "timeline" }));
    focus(layout, only);
    press(deck, { key: "Backspace", altKey: true });
    expect(layout.snapshot().panes).toHaveLength(0);
  });

  it("negative control: the same keys without Alt do nothing", () => {
    // Without this, the two cases above would pass over a deck that acted on every
    // arrow key — which would make every text field inside a pane unusable.
    const layout = emptyLayout();
    const first = layout.open({ kind: "timeline", entity: undefined });
    layout.open({ kind: "runs", entity: undefined });
    const deck = renderDeck(layout, registryWith({ kind: "timeline" }, { kind: "runs" }));
    focus(layout, first);
    press(deck, { key: "ArrowRight" });
    press(deck, { key: "Backspace" });
    expect(layout.snapshot().focusedPaneId).toBe(first);
    expect(layout.snapshot().panes).toHaveLength(2);
  });
});

/**
 * Focus a pane and let React commit before the next act.
 *
 * The commit is what the assertions depend on: the deck's key handler closes over
 * the focused pane id from its last render, so a mutation whose re-render has not
 * flushed leaves the handler acting on the pane before last.
 */
function focus(layout: DeckLayout, paneId: string): void {
  act(() => {
    layout.focus(paneId);
  });
}

/** Dispatch one keydown the way a person's key reaches the deck: by bubbling. */
function press(deck: HTMLElement, init: KeyboardEventInit): void {
  act(() => {
    deck.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}
