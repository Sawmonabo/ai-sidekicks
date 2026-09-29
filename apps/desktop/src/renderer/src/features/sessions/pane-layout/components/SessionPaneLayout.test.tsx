// The pane layout: one body per kind, one pane per entity, and the door that enforces both.
//
// The negative control this file exists for is the SECOND MOUNT DOOR. A registry
// that quietly replaced a claimed kind would look identical on screen — the pane
// would render, just somebody else's body — and which one you got would depend on
// module import order, which nothing in a test or a review can see.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP } from "../pane-layout-store.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { FIRST_RUN_SCENARIO } from "../../../../../../../fixtures/scenarios/first-run.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { PaneRegistry, type PaneContext } from "@renderer/console/seats/index.js";
import { SessionPaneLayout } from "./SessionPaneLayout.js";
import { PaneLayoutStore } from "../pane-layout-store.js";
import type { SessionPane } from "../pane-layout.js";
import { separatorValueBoundsAreOrdered } from "../separator-value-bounds.js";

function emptyLayout(): PaneLayoutStore {
  return new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
}

/**
 * The pane context, cast.
 *
 * Every body below renders a marker string and reads nothing from the context —
 * the subject is the pane layout's frame, not a pane's content — so constructing four
 * stores (one of which opens a database) to satisfy fields nothing reads would make
 * the setup the subject. `TranscriptPane.test.tsx` makes the same trade for the same
 * reason.
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
      // A body with a text field in it, because the pane layout's keyboard guard is about
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
 * The pane layout under the two providers the frame mounts above every surface.
 *
 * Not decoration: the pane layout reads `useAnnounce` to say what a drop settled on and
 * `useClock` to hand its rect tracker the window's own time base, and both
 * throw outside their provider by design. `AppFrame` mounts both above every
 * surface, so a bare `render(<SessionPaneLayout/>)` here would be a mount shape production never
 * has — and the throw is the primitive refusing to let a surface speak through a
 * region nobody created, or read a clock no window resolved, which is a rule worth
 * honoring in a test rather than working around.
 */
function PaneLayoutWindow(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <PlatformBridgeProvider bridge={createFixtureBridge({ scenario: FIRST_RUN_SCENARIO })}>
      <LiveAnnouncerProvider>{props.children}</LiveAnnouncerProvider>
    </PlatformBridgeProvider>
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

/** Three panes side by side — the arrangement the library's ARIA defect shows on. */
function threePaneLayout(): HTMLElement {
  const layout = emptyLayout();
  layout.open({ kind: "transcript" });
  layout.open({ kind: "runs" });
  layout.open({ kind: "approvals" });
  return renderPaneLayout(
    layout,
    registryWith({ kind: "transcript" }, { kind: "runs" }, { kind: "approvals" }),
  );
}

describe("the pane layout's mount door", () => {
  it("refuses a second owner claiming a kind rather than replacing the first", () => {
    const registry = registryWith({ kind: "transcript", owner: "ledger" });
    expect(() =>
      registry.register({
        kind: "transcript",
        owner: "somebody-else",
        render: () => null,
      }),
    ).toThrow();
  });

  it("negative control: the SAME owner re-registering replaces, so a hot reload works", () => {
    // Without this, the case above would pass over a registry that refused every
    // second registration, which would make reloading a module fatal.
    const registry = registryWith({ kind: "transcript", owner: "ledger" });
    expect(() =>
      registry.register({
        kind: "transcript",
        owner: "ledger",
        render: () => null,
      }),
    ).not.toThrow();
  });
});

describe("the pane layout's panes", () => {
  it("mounts one body per open pane, in the layout's order", () => {
    const layout = emptyLayout();
    layout.open({ kind: "transcript" });
    layout.open({ kind: "runs" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "runs" }),
    );
    expect(
      [...paneLayoutElement.querySelectorAll("p")].map((body) => body.textContent),
    ).toStrictEqual(["transcript body", "runs body"]);
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
    // The ARIA is the library's, which is the reason the row adopts it rather than
    // keeping the own-built bar: a focusable `role="separator"` carrying a live
    // `aria-valuenow` is what makes resizing operable without a pointer.
    const paneLayoutElement = threePaneLayout();
    for (const separator of paneLayoutElement.querySelectorAll('[role="separator"]')) {
      // The SEPARATOR is vertical inside a horizontal group — the bar stands up
      // between two panes that sit side by side.
      expect(separator.getAttribute("aria-orientation")).toBe("vertical");
      expect(separator.getAttribute("tabindex")).toBe("0");
    }
  });

  it("announces a range the right way round on a pane layout of three panes", () => {
    // Upstream issue #740 crosses `aria-valuemin` and `aria-valuemax` on every
    // separator after the first at the pinned 4.12.3, so the pane layout corrects them
    // after each commit. The predicate here is the correction's own.
    expect(separatorValueBoundsAreOrdered(threePaneLayout())).toBe(true);
  });

  it("negative control: the same assertion FAILS when the swap is simulated", () => {
    // Without this the case above would pass over a predicate that cannot see the
    // defect at all — the swap is invisible on screen, so nothing else would.
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
    // Scoped to the pane layout's own strip rather than the first `role="status"` in the
    // tree: the announcer's polite region carries that role too and renders above
    // everything, so a bare role selector would find an empty live region.
    expect(
      container.querySelector('.meridian-pane-layout__refusals[role="status"]')?.textContent,
    ).toContain("written by a different version");
  });
});

describe("the pane layout's keyboard paths", () => {
  it("moves focus with Alt+Arrow and moves the PANE with Alt+Shift+Arrow", () => {
    const layout = emptyLayout();
    const first = layout.open({ kind: "transcript" });
    const second = layout.open({ kind: "runs" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "runs" }),
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
    // The defect: Option+Arrow is word-wise caret movement on macOS and
    // Option+Backspace deletes a word, so typing in a pane's find field rearranged
    // or closed the pane it was typed in — and `preventDefault` swallowed the
    // keystroke the person meant.
    const layout = emptyLayout();
    const first = layout.open({ kind: "transcript" });
    layout.open({ kind: "runs" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "runs" }),
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
    // Without this, the case above would pass over a pane layout whose keyboard paths were
    // dead everywhere rather than declining only where a widget owns the keys.
    const layout = emptyLayout();
    const first = layout.open({ kind: "transcript" });
    const second = layout.open({ kind: "runs" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "runs" }),
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
    // Without this, the two cases above would pass over a pane layout that acted on every
    // arrow key — which would make every text field inside a pane unusable.
    const layout = emptyLayout();
    const first = layout.open({ kind: "transcript" });
    layout.open({ kind: "runs" });
    const paneLayoutElement = renderPaneLayout(
      layout,
      registryWith({ kind: "transcript" }, { kind: "runs" }),
    );
    focus(layout, first);
    press(paneLayoutElement, { key: "ArrowRight" });
    press(paneLayoutElement, { key: "Backspace" });
    expect(layout.snapshot().focusedPaneId).toBe(first);
    expect(layout.snapshot().panes).toHaveLength(2);
  });
});

/**
 * Focus a pane and let React commit before the next act.
 *
 * The commit is what the assertions depend on: the pane layout's key handler closes over
 * the focused pane id from its last render, so a mutation whose re-render has not
 * flushed leaves the handler acting on the pane before last.
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
 * Dispatch one keydown from a named element and hand the event back.
 *
 * The event itself is the subject of the editable-target cases: whether the pane layout
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

describe("SessionPaneLayout — the clock its rect flush runs on", () => {
  /** The scenario's frozen clock, or a failure that says the fixture served none. */
  function frozenClockOf(bridge: PlatformBridge): ManualClock {
    const clock = bridge.scenarioEngine?.clock;
    if (!(clock instanceof ManualClock)) {
      throw new Error("the fixture bridge resolved no frozen clock");
    }
    return clock;
  }

  function renderPaneLayoutOn(bridge: PlatformBridge): void {
    const layout = emptyLayout();
    layout.open({ kind: "transcript" });
    render(
      <PlatformBridgeProvider bridge={bridge}>
        <LiveAnnouncerProvider>
          <SessionPaneLayout
            layout={layout}
            registry={registryWith({ kind: "transcript" })}
            paneContextFor={paneContextFor}
          />
        </LiveAnnouncerProvider>
      </PlatformBridgeProvider>,
    );
  }

  it("arms its flush on the window's own clock, so a frozen fixture decides when it lands", () => {
    // The pane layout used to mint a `RealClock` of its own, which in fixture mode is a
    // second time base beside the frozen one every other surface in the window reads:
    // the rect flush then ran on wall time while the transcript and the reveal engine
    // were frozen, and whether it had fired when a screenshot was taken
    // depended on how long the runner took.
    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const clock = frozenClockOf(bridge);

    renderPaneLayoutOn(bridge);

    // Armed and not yet run — `rect/rect-discipline.ts` rule 1 is reads in the callback and
    // writes on the next frame, and the frame is this window's.
    expect(clock.pendingFrameCount).toBe(1);
    act(() => {
      clock.runFrame();
    });
    expect(clock.pendingFrameCount).toBe(0);
  });

  it("negative control: the frozen clock has nothing armed until a pane layout is mounted", () => {
    // Without this, the case above would pass over a clock that reported a pending
    // frame for anything at all, including work no pane layout ever asked for.
    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    expect(frozenClockOf(bridge).pendingFrameCount).toBe(0);
  });
});
