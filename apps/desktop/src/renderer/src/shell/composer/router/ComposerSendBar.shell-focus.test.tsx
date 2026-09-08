// The caret the shell asks for lands on the line, and on nothing else.
//
// This is the end of the path a composer chord pressed in an auxiliary window takes:
// main activates this window and then sends a focus request, the frame's binding
// lands it in the composer seat, and the bar's own subscription moves the caret. The
// window activation on its own does NOT do this — it restores whatever control the
// window last had focus on — which is exactly what the negative control here pins.

import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../console/core/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { useShellComposerFocusRequests } from "../../../console/seats/index.js";
import { shellProbe, type ShellProbe } from "../../../console/bridge/shell-signals.test-support.js";
import { mountBar, openSessionStore } from "./composer-send-bar.test-support.js";

/** The frame's one binding, mounted alone so the case drives nothing else. */
function ShellRequestBinding(props: { readonly shell: ShellProbe }): null {
  useShellComposerFocusRequests(props.shell.bridge);
  return null;
}

interface MountedWindow {
  readonly shell: ShellProbe;
  /** The composer's directive line. */
  readonly line: HTMLTextAreaElement;
  /** Whatever this window had focus on before the chord — a sidebar control. */
  readonly previouslyActiveControl: HTMLButtonElement;
}

/**
 * A window holding the composer, the frame's shell binding, and one other control.
 *
 * The third element is the point of the whole suite: with only a composer on screen
 * every focus assertion passes trivially, because there is nowhere else for the
 * caret to be. The button stands for the ledger row, sidebar entry, or rail
 * destination the person last touched.
 */
function openWindow(): MountedWindow {
  const shell = shellProbe();
  const bar = mountBar({
    bridge: shell.bridge,
    draftStore: new DraftStore({
      maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
      restartNoticePending: false,
    }),
    sessionStore: openSessionStore(),
  });
  render(<ShellRequestBinding shell={shell} />);

  const sidebarControl = render(<button type="button">Sessions</button>);
  const previouslyActiveControl = sidebarControl.container.querySelector("button");
  if (!(previouslyActiveControl instanceof HTMLButtonElement)) {
    throw new Error("the stand-in sidebar control did not render");
  }
  previouslyActiveControl.focus();

  return { shell, line: bar.line, previouslyActiveControl };
}

afterEach(() => {
  cleanup();
});

describe("the caret the shell asks this window for", () => {
  it("lands on the composer's line, taking it off the control the window had", () => {
    const openedWindow = openWindow();
    expect(document.activeElement).toBe(openedWindow.previouslyActiveControl);

    openedWindow.shell.raiseComposerFocusRequest();

    expect(document.activeElement).toBe(openedWindow.line);
  });

  it("negative control: no request means the window keeps the control it had", () => {
    // What activating the window alone does. `BrowserWindow.focus()` restores the
    // renderer's own focused element, so without the request the chord returns the
    // person to whichever control they were on — the defect this pair exists over.
    const openedWindow = openWindow();

    expect(document.activeElement).toBe(openedWindow.previouslyActiveControl);
    expect(document.activeElement).not.toBe(openedWindow.line);
  });

  it("stops moving the caret once the window's surfaces are gone", () => {
    // A request delivered into an unmounted window must reach nobody: the seat drops
    // an ask with no composer listening, and the binding has released the bridge.
    const openedWindow = openWindow();
    cleanup();

    expect(() => {
      openedWindow.shell.raiseComposerFocusRequest();
    }).not.toThrow();
    expect(openedWindow.shell.openSubscriptionCount()).toBe(0);
  });
});
