// The deck: one body per kind, one pane per entity, and the door that enforces both.
//
// The negative control this file exists for is the SECOND MOUNT DOOR. A registry
// that quietly replaced a claimed kind would look identical on screen — the pane
// would render, just somebody else's body — and which one you got would depend on
// module import order, which nothing in a test or a review can see.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DECK_RESTORED_PANE_CAP, ManualClock } from "../../core/index.js";
import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
} from "../../bridge/index.js";
import { FIRST_RUN_SCENARIO } from "../../bridge/scenarios/first-run.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { ConsolePaneRegistry, type ConsolePaneContext } from "../../seats/index.js";
import { Deck } from "./Deck.js";
import { DeckLayout } from "./deck-layout.js";
import type { DeckPane } from "./deck-model.js";
import { separatorValueBoundsAreOrdered } from "./separator-aria.js";

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
  ...descriptors: readonly { kind: DeckPane["kind"]; owner?: string }[]
): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  for (const descriptor of descriptors) {
    registry.register({
      kind: descriptor.kind,
      owner: descriptor.owner ?? "deck-test",
      // A body with a text field in it, because the deck's keyboard guard is about
      // where a keystroke came FROM: a marker-only body could not tell a chord
      // taken from the chrome apart from one taken out of somebody's typing.
      render: (context) => (
        <>
          <p data-pane={context.paneId}>{descriptor.kind} body</p>
          <textarea aria-label={`${descriptor.kind} notes`} />
        </>
      ),
    });
  }
  return registry;
}

/**
 * The deck under the two providers the frame mounts above every surface.
 *
 * Not decoration: the deck reads `useAnnounce` to say what a drop settled on and
 * `useConsoleClock` to hand its rect tracker the window's own time base, and both
 * throw outside their provider by design. `AppFrame` mounts both above every
 * surface, so a bare `render(<Deck/>)` here would be a mount shape production never
 * has — and the throw is the primitive refusing to let a surface speak through a
 * region nobody created, or read a clock no window resolved, which is a rule worth
 * honouring in a test rather than working around.
 */
function DeckWindow(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: FIRST_RUN_SCENARIO })}>
      <LiveAnnouncerProvider>{props.children}</LiveAnnouncerProvider>
    </SidekicksBridgeProvider>
  );
}

function renderDeck(layout: DeckLayout, registry: ConsolePaneRegistry): HTMLElement {
  const { container } = render(
    <DeckWindow>
      <Deck layout={layout} registry={registry} paneContextFor={paneContextFor} />
    </DeckWindow>,
  );
  const deck = container.querySelector(".meridian-deck");
  if (!(deck instanceof HTMLElement)) {
    throw new Error("Deck rendered no deck element");
  }
  return deck;
}

/** Three panes side by side — the arrangement the library's ARIA defect shows on. */
function threePaneDeck(): HTMLElement {
  const layout = emptyLayout();
  layout.open({ kind: "timeline", entity: undefined });
  layout.open({ kind: "runs", entity: undefined });
  layout.open({ kind: "approvals", entity: undefined });
  return renderDeck(
    layout,
    registryWith({ kind: "timeline" }, { kind: "runs" }, { kind: "approvals" }),
  );
}

describe("the deck's mount door", () => {
  it("refuses a second owner claiming a kind rather than replacing the first", () => {
    const registry = registryWith({ kind: "timeline", owner: "ledger" });
    expect(() =>
      registry.register({
        kind: "timeline",
        owner: "somebody-else",
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
    const deck = threePaneDeck();
    expect(deck.querySelectorAll('[role="separator"]')).toHaveLength(2);
    expect(deck.querySelectorAll("[data-panel]")).toHaveLength(3);
  });

  it("gives every separator the window-splitter role the library provides", () => {
    // The ARIA is the library's, which is the reason the row adopts it rather than
    // keeping the own-built bar: a focusable `role="separator"` carrying a live
    // `aria-valuenow` is what makes resizing operable without a pointer.
    const deck = threePaneDeck();
    for (const separator of deck.querySelectorAll('[role="separator"]')) {
      // The SEPARATOR is vertical inside a horizontal group — the bar stands up
      // between two panes that sit side by side.
      expect(separator.getAttribute("aria-orientation")).toBe("vertical");
      expect(separator.getAttribute("tabindex")).toBe("0");
    }
  });

  it("announces a range the right way round on a three-pane deck", () => {
    // Upstream issue #740 crosses `aria-valuemin` and `aria-valuemax` on every
    // separator after the first at the pinned 4.12.3, so the deck corrects them
    // after each commit. The predicate here is the correction's own.
    expect(separatorValueBoundsAreOrdered(threePaneDeck())).toBe(true);
  });

  it("negative control: the same assertion FAILS when the swap is simulated", () => {
    // Without this the case above would pass over a predicate that cannot see the
    // defect at all — the swap is invisible on screen, so nothing else would.
    const deck = threePaneDeck();
    const separator = deck.querySelector('[role="separator"]');
    expect(separator).not.toBeNull();
    separator?.setAttribute("aria-valuemin", "90");
    separator?.setAttribute("aria-valuemax", "10");
    expect(separatorValueBoundsAreOrdered(deck)).toBe(false);
  });

  it("says the deck is empty rather than rendering an unexplained blank", () => {
    const deck = renderDeck(emptyLayout(), registryWith({ kind: "timeline" }));
    expect(deck.textContent).toContain("No panes are open.");
  });

  it("renders what a restore refused, inside the deck the refusal is about", () => {
    const layout = emptyLayout();
    const report = layout.restore({ $deck: { version: 99 } });
    const { container } = render(
      <DeckWindow>
        <Deck
          layout={layout}
          registry={registryWith({ kind: "timeline" })}
          paneContextFor={paneContextFor}
          restoreRefusals={report.refusals}
        />
      </DeckWindow>,
    );
    // Scoped to the deck's own strip rather than the first `role="status"` in the
    // tree: the announcer's polite region carries that role too and renders above
    // everything, so a bare role selector would find an empty live region.
    expect(
      container.querySelector('.meridian-deck__refusals[role="status"]')?.textContent,
    ).toContain("written by a different version");
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

  it("never takes a chord from an editable target inside a pane body", () => {
    // The defect: Option+Arrow is word-wise caret movement on macOS and
    // Option+Backspace deletes a word, so typing in a pane's find field rearranged
    // or closed the pane it was typed in — and `preventDefault` swallowed the
    // keystroke the person meant.
    const layout = emptyLayout();
    const first = layout.open({ kind: "timeline", entity: undefined });
    layout.open({ kind: "runs", entity: undefined });
    const deck = renderDeck(layout, registryWith({ kind: "timeline" }, { kind: "runs" }));
    focus(layout, first);

    const field = deck.querySelector("textarea");
    expect(field).not.toBeNull();
    const moveEvent = pressFrom(field, { key: "ArrowRight", altKey: true, shiftKey: true });
    const closeEvent = pressFrom(field, { key: "Backspace", altKey: true });

    expect(layout.snapshot().panes.map((pane) => pane.paneId)[0]).toBe(first);
    expect(layout.snapshot().panes).toHaveLength(2);
    expect(moveEvent.defaultPrevented).toBe(false);
    expect(closeEvent.defaultPrevented).toBe(false);
  });

  it("negative control: the same chord from the pane chrome still moves the pane", () => {
    // Without this, the case above would pass over a deck whose keyboard paths were
    // dead everywhere rather than declining only where a widget owns the keys.
    const layout = emptyLayout();
    const first = layout.open({ kind: "timeline", entity: undefined });
    const second = layout.open({ kind: "runs", entity: undefined });
    const deck = renderDeck(layout, registryWith({ kind: "timeline" }, { kind: "runs" }));
    focus(layout, first);

    const moveEvent = pressFrom(deck, { key: "ArrowRight", altKey: true, shiftKey: true });

    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([second, first]);
    expect(moveEvent.defaultPrevented).toBe(true);
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

/**
 * Dispatch one keydown from a named element and hand the event back.
 *
 * The event itself is the subject of the editable-target cases: whether the deck
 * called `preventDefault` is the difference between declining a keystroke and
 * swallowing it, and only the dispatched object carries that.
 */
function pressFrom(origin: Element | null, init: KeyboardEventInit): KeyboardEvent {
  if (origin === null) {
    throw new Error("no element to dispatch the keydown from");
  }
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    origin.dispatchEvent(event);
  });
  return event;
}

describe("Deck — the clock its rect flush runs on", () => {
  /** The scenario's frozen clock, or a failure that says the fixture served none. */
  function frozenClockOf(bridge: ConsoleBridge): ManualClock {
    const clock = bridge.scenarioEngine?.clock;
    if (!(clock instanceof ManualClock)) {
      throw new Error("the fixture bridge resolved no frozen clock");
    }
    return clock;
  }

  function renderDeckOn(bridge: ConsoleBridge): void {
    const layout = emptyLayout();
    layout.open({ kind: "timeline", entity: undefined });
    render(
      <SidekicksBridgeProvider bridge={bridge}>
        <LiveAnnouncerProvider>
          <Deck
            layout={layout}
            registry={registryWith({ kind: "timeline" })}
            paneContextFor={paneContextFor}
          />
        </LiveAnnouncerProvider>
      </SidekicksBridgeProvider>,
    );
  }

  it("arms its flush on the window's own clock, so a frozen fixture decides when it lands", () => {
    // The deck used to mint a `RealClock` of its own, which in fixture mode is a
    // second time base beside the frozen one every other surface in the window reads:
    // the rect flush then ran on wall time while the ledger, the replay dock and the
    // reveal engine were frozen, and whether it had fired when a screenshot was taken
    // depended on how long the runner took.
    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const clock = frozenClockOf(bridge);

    renderDeckOn(bridge);

    // Armed and not yet run — `rect-discipline.ts` rule 1 is reads in the callback and
    // writes on the next frame, and the frame is this window's.
    expect(clock.pendingFrameCount).toBe(1);
    act(() => {
      clock.runFrame();
    });
    expect(clock.pendingFrameCount).toBe(0);
  });

  it("negative control: the frozen clock has nothing armed until a deck is mounted", () => {
    // Without this, the case above would pass over a clock that reported a pending
    // frame for anything at all, including work no deck ever asked for.
    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    expect(frozenClockOf(bridge).pendingFrameCount).toBe(0);
  });
});
