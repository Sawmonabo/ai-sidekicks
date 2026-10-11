// The mounted pane layout's own keys: focus and close from the block, Escape giving the full
// width back, and none of it taken from a field inside a pane body; and what its edges are called.

import { act, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { layoutPaneContext } from "#test/helpers/pane-context.js";
import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { SessionPaneLayout } from "./SessionPaneLayout.js";
import { PaneLayoutStore } from "../store.js";

/** Sidekicks, Preview and the terminal, Sidekicks focused. */
function threePaneLayout(): {
  readonly layout: PaneLayoutStore;
  readonly sidekicks: string;
  readonly preview: string;
} {
  const layout = new PaneLayoutStore();
  const sidekicks = layout.open({ kind: "agents" });
  const preview = layout.open({ kind: "browser" });
  layout.open({ kind: "terminal" });
  layout.focus(sidekicks);
  return { layout, sidekicks, preview };
}

/**
 * A registry whose bodies are framed panes holding a text field, because the keyboard guard is
 * about where a keystroke came from, and a marker-only body could not tell chrome from typing.
 */
function registryWithFields(): PaneRegistry {
  const registry = new PaneRegistry();
  for (const kind of ["agents", "browser", "terminal"] as const) {
    registry.register({
      kind,
      owner: "pane-layout-test",
      render: (context) => (
        <PaneFrame kind={kind} sessionId={undefined}>
          <p data-pane={context.paneId}>{kind} body</p>
          <textarea aria-label={`${kind} notes`} />
        </PaneFrame>
      ),
    });
  }
  return registry;
}

/**
 * The pane layout under the two providers the frame mounts above every view, each pane's context
 * built from its address the way the session screen builds it. `useAnnounce` and `useClock`
 * throw outside their provider by design, so a bare render would be a mount shape production
 * never has. Returns the block, where a person's keys inside the panes bubble to.
 */
function renderPaneLayout(layout: PaneLayoutStore): HTMLElement {
  const fixture = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
  const { container } = render(
    <FixtureBridgeProvider fixture={fixture}>
      <LiveAnnouncerProvider>
        <SessionPaneLayout
          layout={layout}
          registry={registryWithFields()}
          paneContextFor={(pane) =>
            layoutPaneContext(pane, { bridge: fixture.bridge, sessionStore: undefined })
          }
          isSessionOpen
          sessionId={undefined}
          conversation={<p>the conversation</p>}
        />
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  const block = container.querySelector(".meridian-pane-layout__block");
  if (!(block instanceof HTMLElement)) {
    throw new Error("SessionPaneLayout drew no block of panes");
  }
  return block;
}

function paneFrameOf(block: HTMLElement, paneId: string): HTMLElement {
  const frame = block.querySelector<HTMLElement>(`[data-pane-id="${paneId}"] .meridian-pane`);
  if (frame === null) {
    throw new Error(`no pane frame was drawn for ${paneId}`);
  }
  return frame;
}

describe("the block's own keys", () => {
  it("focuses the next pane on Alt+Arrow and closes the focused one on Alt+Backspace", () => {
    const { layout, sidekicks, preview } = threePaneLayout();
    const block = renderPaneLayout(layout);

    pressFrom(paneFrameOf(block, sidekicks), { key: "ArrowRight", altKey: true });
    expect(layout.snapshot().focusedPaneId).toBe(preview);

    // Preview opened from Sidekicks' focus, so closing it hands the window's focus back there
    // rather than leaving it on the document's body.
    act(() => {
      paneFrameOf(block, preview).focus();
    });
    pressFrom(paneFrameOf(block, preview), { key: "Backspace", altKey: true });
    expect(layout.snapshot().panes.map((pane) => pane.paneId)).not.toContain(preview);
    expect(document.activeElement).toBe(paneFrameOf(block, sidekicks));
  });

  it("never takes a chord or Escape from a field inside a pane body", () => {
    // Option+Arrow is word-wise caret movement on macOS and Option+Backspace deletes a word, and
    // Escape typed into the terminal is the shell's, so a chord taken from a field would
    // rearrange or close the pane, and `preventDefault` would swallow the keystroke.
    const { layout, sidekicks, preview } = threePaneLayout();
    const block = renderPaneLayout(layout);
    act(() => {
      layout.setFullWidth(preview);
    });
    const field = block.querySelector("textarea");

    const focusEvent = pressFrom(field, { key: "ArrowRight", altKey: true });
    const closeEvent = pressFrom(field, { key: "Backspace", altKey: true });
    const escapeEvent = pressFrom(field, { key: "Escape" });

    expect(layout.snapshot().focusedPaneId).toBe(sidekicks);
    expect(layout.snapshot().panes).toHaveLength(3);
    expect(layout.snapshot().fullWidthPaneId).toBe(preview);
    expect([focusEvent, closeEvent, escapeEvent].map((event) => event.defaultPrevented)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("negative control: the same keys from the pane chrome act", () => {
    // Without this, the case above would pass over keyboard paths that were dead everywhere.
    const { layout, sidekicks, preview } = threePaneLayout();
    const block = renderPaneLayout(layout);
    act(() => {
      layout.setFullWidth(preview);
    });
    // The toggle keeps its name and carries its state; only its hover title flips.
    const toggle = within(paneFrameOf(block, preview)).getByRole("button", { name: "Full width" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("data-hover-label")).toBe("Back to the side (Esc)");

    const escapeEvent = pressFrom(paneFrameOf(block, preview), { key: "Escape" });
    const focusEvent = pressFrom(paneFrameOf(block, sidekicks), {
      key: "ArrowRight",
      altKey: true,
    });

    expect(layout.snapshot().fullWidthPaneId).toBeUndefined();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("data-hover-label")).toBe("Full width");
    expect(layout.snapshot().focusedPaneId).toBe(preview);
    expect([escapeEvent, focusEvent].map((event) => event.defaultPrevented)).toEqual([true, true]);
  });
});

describe("the block's edges", () => {
  it("names each edge by its own pane's label, as a window splitter is named", () => {
    // The role and orientation already say it resizes; a name pointing at an id no pane drew
    // would leave the edge unnamed.
    const { layout } = threePaneLayout();
    const block = renderPaneLayout(layout);

    const previewEdge = within(block).getByRole("separator", { name: "Preview" });
    const terminalEdge = within(block).getByRole("separator", { name: "Terminal" });

    expect(previewEdge.getAttribute("aria-orientation")).toBe("vertical");
    expect(terminalEdge.getAttribute("aria-orientation")).toBe("horizontal");
  });
});

/**
 * Dispatch one keydown from an element, by bubbling as a person's key does, and hand the event
 * back: `preventDefault` separates declining a keystroke from swallowing it.
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
