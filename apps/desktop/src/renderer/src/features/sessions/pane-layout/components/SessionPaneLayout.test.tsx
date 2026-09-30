// The pane layout: one body per kind, one pane per entity, and the registry that enforces
// both. The negative control this file exists for is a second owner claiming a kind: a
// registry that quietly replaced it would look identical on screen, and which body rendered
// would depend on module import order.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP } from "../pane-layout-store.js";
import { ManualClock, type Clock } from "@renderer/lib/clock.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { FIRST_RUN_SCENARIO } from "../../../../../../../fixtures/scenarios/first-run.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { SessionPaneLayout } from "./SessionPaneLayout.js";
import { PaneLayoutStore } from "../pane-layout-store.js";
import type { SessionPane } from "../pane-layout.js";
import { separatorValueBoundsAreOrdered } from "../separator-value-bounds.js";

function emptyLayout(): PaneLayoutStore {
  return new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
}

/**
 * The pane context, cast. Every body below renders a marker and reads nothing from the
 * context, so constructing four stores to fill fields nothing reads would make the setup the
 * subject.
 */
function paneContextFor(pane: SessionPane): PaneContext {
  return {
    kind: pane.kind,
    entity: pane.entity,
    paneId: pane.paneId,
  } as unknown as PaneContext;
}

/** A registry whose bodies say which pane they are, and nothing else. */
function registryWith(
  ...descriptors: readonly { kind: SessionPane["kind"]; owner?: string }[]
): PaneRegistry {
  const registry = new PaneRegistry();
  for (const descriptor of descriptors) {
    registry.register({
      kind: descriptor.kind,
      owner: descriptor.owner ?? "pane-layout-test",
      // A body with a text field, because the keyboard guard is about where a keystroke came
      // from, and a marker-only body could not tell chrome from someone's typing.
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
 * The pane layout under the two providers the frame mounts above every view. `useAnnounce`
 * and `useClock` throw outside their provider by design, so a bare render would be a mount
 * shape production never has.
 */
function PaneLayoutWindow(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: FIRST_RUN_SCENARIO })}>
      <LiveAnnouncerProvider>{props.children}</LiveAnnouncerProvider>
    </FixtureBridgeProvider>
  );
}

function renderPaneLayout(layout: PaneLayoutStore, registry: PaneRegistry): HTMLElement {
  const { container } = render(
    <PaneLayoutWindow>
      <SessionPaneLayout layout={layout} registry={registry} paneContextFor={paneContextFor} />
    </PaneLayoutWindow>,
  );
  const paneLayoutElement = container.querySelector(".meridian-pane-layout");
  if (!(paneLayoutElement instanceof HTMLElement)) {
    throw new Error("SessionPaneLayout rendered no pane layout element");
  }
  return paneLayoutElement;
}

/** Three panes side by side, the arrangement the library's ARIA defect shows on. */
function threePaneLayout(): HTMLElement {
  const layout = emptyLayout();
  layout.open({ kind: "transcript" });
  layout.open({ kind: "terminal" });
  layout.open({ kind: "agents" });
  return renderPaneLayout(
    layout,
    registryWith({ kind: "transcript" }, { kind: "terminal" }, { kind: "agents" }),
  );
}

describe("the pane layout's pane registry", () => {
  it("refuses a second owner claiming a kind rather than replacing the first", () => {
    const registry = registryWith({ kind: "transcript", owner: "transcript" });
    expect(() =>
      registry.register({
        kind: "transcript",
        owner: "somebody-else",
        render: () => null,
      }),
    ).toThrow();
  });

  it("negative control: the SAME owner re-registering replaces, so a hot reload works", () => {
    // Without this, the case above would pass over a registry that refused every second
    // registration, making a module reload fatal.
    const registry = registryWith({ kind: "transcript", owner: "transcript" });
    expect(() =>
      registry.register({
        kind: "transcript",
        owner: "transcript",
        render: () => null,
      }),
    ).not.toThrow();
  });
});

describe("the pane layout's panes", () => {
  it("mounts one body per open pane, in the layout's order", () => {
    const layout = emptyLayout();
    layout.open({ kind: "transcript" });
    layout.open({ kind: "terminal" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "terminal" }),
    );
    expect(
      [...paneLayoutElement.querySelectorAll("p")].map((body) => body.textContent),
    ).toStrictEqual(["transcript body", "terminal body"]);
  });

  it("focuses the pane that already shows an entity instead of opening a second", () => {
    const layout = emptyLayout();
    const first = layout.open({ kind: "inspector", entity: { kind: "worktree", id: "you" } });
    const second = layout.open({ kind: "inspector", entity: { kind: "worktree", id: "you" } });
    const paneLayoutElement = renderPaneLayout(layout, registryWith({ kind: "inspector" }));
    expect(second).toBe(first);
    expect(paneLayoutElement.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(1);
  });

  it("puts a separator between panes and none before the first", () => {
    const paneLayoutElement = threePaneLayout();
    expect(paneLayoutElement.querySelectorAll('[role="separator"]')).toHaveLength(2);
    expect(paneLayoutElement.querySelectorAll("[data-panel]")).toHaveLength(3);
  });

  it("gives every separator the window-splitter role the library provides", () => {
    // The ARIA is the library's: a focusable `role="separator"` with a live `aria-valuenow`
    // makes resizing operable without a pointer.
    const paneLayoutElement = threePaneLayout();
    for (const separator of paneLayoutElement.querySelectorAll('[role="separator"]')) {
      // The separator is vertical inside a horizontal group.
      expect(separator.getAttribute("aria-orientation")).toBe("vertical");
      expect(separator.getAttribute("tabindex")).toBe("0");
    }
  });

  it("announces a range the right way round on a pane layout of three panes", () => {
    // The library crosses `aria-valuemin` and `aria-valuemax` on every separator after the
    // first at the pinned version, so the pane layout corrects them after each commit; the
    // predicate is the correction's own.
    expect(separatorValueBoundsAreOrdered(threePaneLayout())).toBe(true);
  });

  it("negative control: the same assertion FAILS when the swap is simulated", () => {
    // Without this, the case above would pass over a predicate that cannot see the defect,
    // which is invisible on screen.
    const paneLayoutElement = threePaneLayout();
    const separator = paneLayoutElement.querySelector('[role="separator"]');
    expect(separator).not.toBeNull();
    separator?.setAttribute("aria-valuemin", "90");
    separator?.setAttribute("aria-valuemax", "10");
    expect(separatorValueBoundsAreOrdered(paneLayoutElement)).toBe(false);
  });

  it("says the pane layout is empty rather than rendering an unexplained blank", () => {
    const paneLayoutElement = renderPaneLayout(emptyLayout(), registryWith({ kind: "transcript" }));
    expect(paneLayoutElement.textContent).toContain("No panes are open.");
  });

  it("renders what a restore refused, inside the pane layout the refusal is about", () => {
    const layout = emptyLayout();
    const report = layout.restore({ $paneLayout: { version: 99 } });
    const { container } = render(
      <PaneLayoutWindow>
        <SessionPaneLayout
          layout={layout}
          registry={registryWith({ kind: "transcript" })}
          paneContextFor={paneContextFor}
          restoreRefusals={report.refusals}
        />
      </PaneLayoutWindow>,
    );
    // Scoped to the pane layout's strip: the announcer's polite region also has
    // `role="status"` and renders above everything.
    expect(
      container.querySelector('.meridian-pane-layout__refusals[role="status"]')?.textContent,
    ).toContain("written by a different version");
  });
});

describe("the pane layout's keyboard paths", () => {
  it("moves focus with Alt+Arrow and moves the PANE with Alt+Shift+Arrow", () => {
    const layout = emptyLayout();
    const first = layout.open({ kind: "transcript" });
    const second = layout.open({ kind: "terminal" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "terminal" }),
    );

    focus(layout, first);
    press(paneLayoutElement, { key: "ArrowRight", altKey: true });
    expect(layout.snapshot().focusedPaneId).toBe(second);

    focus(layout, first);
    press(paneLayoutElement, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([second, first]);
  });

  it("closes the focused pane with Alt+Backspace", () => {
    const layout = emptyLayout();
    const only = layout.open({ kind: "transcript" });
    const paneLayoutElement = renderPaneLayout(layout, registryWith({ kind: "transcript" }));
    focus(layout, only);
    press(paneLayoutElement, { key: "Backspace", altKey: true });
    expect(layout.snapshot().panes).toHaveLength(0);
  });

  it("never takes a chord from an editable target inside a pane body", () => {
    // Option+Arrow is word-wise caret movement on macOS and Option+Backspace deletes a word,
    // so typing in a pane's find field once rearranged or closed the pane, and `preventDefault`
    // swallowed the keystroke.
    const layout = emptyLayout();
    const first = layout.open({ kind: "transcript" });
    layout.open({ kind: "terminal" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "terminal" }),
    );
    focus(layout, first);

    const field = paneLayoutElement.querySelector("textarea");
    expect(field).not.toBeNull();
    const moveEvent = pressFrom(field, { key: "ArrowRight", altKey: true, shiftKey: true });
    const closeEvent = pressFrom(field, { key: "Backspace", altKey: true });

    expect(layout.snapshot().panes.map((pane) => pane.paneId)[0]).toBe(first);
    expect(layout.snapshot().panes).toHaveLength(2);
    expect(moveEvent.defaultPrevented).toBe(false);
    expect(closeEvent.defaultPrevented).toBe(false);
  });

  it("negative control: the same chord from the pane chrome still moves the pane", () => {
    // Without this, the case above would pass over keyboard paths that were dead everywhere.
    const layout = emptyLayout();
    const first = layout.open({ kind: "transcript" });
    const second = layout.open({ kind: "terminal" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "terminal" }),
    );
    focus(layout, first);

    const moveEvent = pressFrom(paneLayoutElement, {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });

    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([second, first]);
    expect(moveEvent.defaultPrevented).toBe(true);
  });

  it("negative control: the same keys without Alt do nothing", () => {
    // Without this, the cases above would pass over a layout that acted on every arrow key.
    const layout = emptyLayout();
    const first = layout.open({ kind: "transcript" });
    layout.open({ kind: "terminal" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "terminal" }),
    );
    focus(layout, first);
    press(paneLayoutElement, { key: "ArrowRight" });
    press(paneLayoutElement, { key: "Backspace" });
    expect(layout.snapshot().focusedPaneId).toBe(first);
    expect(layout.snapshot().panes).toHaveLength(2);
  });
});

/**
 * Focus a pane and let React commit before the next act, since the key handler closes over the
 * focused pane id from its last render.
 */
function focus(layout: PaneLayoutStore, paneId: string): void {
  act(() => {
    layout.focus(paneId);
  });
}

/** Dispatch one keydown the way a person's key reaches the pane layout: by bubbling. */
function press(paneLayoutElement: HTMLElement, init: KeyboardEventInit): void {
  act(() => {
    paneLayoutElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

/**
 * Dispatch one keydown from a named element and hand the event back. The event is the subject
 * of the editable-target cases, since `preventDefault` separates declining a keystroke from
 * swallowing it.
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

describe("SessionPaneLayout — the clock its rect flush runs on", () => {
  /** The scenario's frozen clock, or a failure that says the fixture served none. */
  function frozenClockOf(clock: Clock): ManualClock {
    if (!(clock instanceof ManualClock)) {
      throw new Error("the fixture bridge resolved no frozen clock");
    }
    return clock;
  }

  function renderPaneLayoutOn(fixture: FixtureBridge): void {
    const layout = emptyLayout();
    layout.open({ kind: "transcript" });
    render(
      <FixtureBridgeProvider fixture={fixture}>
        <LiveAnnouncerProvider>
          <SessionPaneLayout
            layout={layout}
            registry={registryWith({ kind: "transcript" })}
            paneContextFor={paneContextFor}
          />
        </LiveAnnouncerProvider>
      </FixtureBridgeProvider>,
    );
  }

  it("arms its flush on the window's own clock, so a frozen fixture decides when it lands", () => {
    // A `RealClock` of the pane layout's own would run the rect flush on wall time while the
    // rest of the window is frozen, so whether it had fired at screenshot time would depend
    // on the runner.
    const fixture = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const clock = frozenClockOf(fixture.scenarioEngine.clock);

    renderPaneLayoutOn(fixture);

    // Armed and not yet run: the tracker reads in the observer callback and writes on the
    // window's next frame.
    expect(clock.pendingFrameCount).toBe(1);
    act(() => {
      clock.runFrame();
    });
    expect(clock.pendingFrameCount).toBe(0);
  });

  it("negative control: the frozen clock has nothing armed until a pane layout is mounted", () => {
    // Without this, the case above would pass over a clock that reported a pending frame for
    // anything.
    const { scenarioEngine } = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    expect(frozenClockOf(scenarioEngine.clock).pendingFrameCount).toBe(0);
  });
});
