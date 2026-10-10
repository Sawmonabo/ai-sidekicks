// The mounted pane layout: one body per open pane, and the keyboard paths it binds on its own
// element.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP } from "../store.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { layoutPaneContext } from "#test/helpers/pane-context.js";
import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { SessionPaneLayout } from "./SessionPaneLayout.js";
import { PaneLayoutStore } from "../store.js";
import type { SessionPane } from "../state.js";

function emptyLayout(): PaneLayoutStore {
  return new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
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
 * The pane layout under the two providers the frame mounts above every view, each pane's context
 * built from its address the way the session screen builds it, over the same bridge. `useAnnounce` and `useClock` throw
 * outside their provider by design, so a bare render would be a mount shape production never has.
 */
function renderPaneLayout(layout: PaneLayoutStore, registry: PaneRegistry): HTMLElement {
  const fixture = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
  const { container } = render(
    <FixtureBridgeProvider fixture={fixture}>
      <LiveAnnouncerProvider>
        <SessionPaneLayout
          layout={layout}
          registry={registry}
          paneContextFor={(pane) =>
            layoutPaneContext(pane, { bridge: fixture.bridge, sessionStore: undefined })
          }
        />
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  const paneLayoutElement = container.querySelector(".meridian-pane-layout");
  if (!(paneLayoutElement instanceof HTMLElement)) {
    throw new Error("SessionPaneLayout rendered no pane layout element");
  }
  return paneLayoutElement;
}

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
    // so a chord taken from a pane's find field would rearrange or close the pane, and
    // `preventDefault` would swallow the keystroke.
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
