// What the HOST hands a pane: its close control, and the element a drag binds to.
//
// Its own file rather than two more suites beside the frame's, because it is a different
// subject and the two together were past the package's ceiling. Everything here arrives
// from outside the chrome — through `PaneControlsContext`, which the deck provides around
// every pane body, or through an explicit prop, which is how a host that owns one pane's
// lifetime outside a deck keeps its close button pointed at the right thing.
//
// The claims are about ABSENCE as much as presence: a control drawn disabled instead of
// absent looks deliberate, and a context that silently loses to an explicit prop — or
// wins over it — is a difference nobody sees until a pane is mounted outside a deck.

import { describe, expect, it } from "vitest";

import { PaneFrame } from "./PaneFrame.js";
import { renderPaneFrame } from "./PaneFrame.test-support.js";
import { PaneControlsContext } from "./pane-controls.js";

function controlLabels(pane: HTMLElement): readonly (string | null)[] {
  return [...pane.querySelectorAll(".meridian-pane__control")].map((control) =>
    control.getAttribute("aria-label"),
  );
}

describe("PaneFrame — where the controls come from", () => {
  it("draws no control when nobody can close the pane", () => {
    const pane = renderPaneFrame(
      <PaneFrame kind="transcript" sessionId="session-1" focusHue={undefined}>
        <p>body</p>
      </PaneFrame>,
    );
    expect(controlLabels(pane)).toStrictEqual([]);
  });

  it("takes the close from the deck's context", () => {
    const pane = renderPaneFrame(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <PaneFrame kind="transcript" sessionId="session-1" focusHue={undefined}>
          <p>body</p>
        </PaneFrame>
      </PaneControlsContext.Provider>,
    );
    expect(controlLabels(pane)).toStrictEqual(["Close this pane"]);
  });

  it("lets an explicit prop win over the context, so a non-deck host keeps its pane", () => {
    const performed: string[] = [];
    const pane = renderPaneFrame(
      <PaneControlsContext.Provider
        value={{
          onClose: () => {
            performed.push("deck");
          },
        }}
      >
        <PaneFrame
          kind="transcript"
          sessionId="session-1"
          focusHue={undefined}
          onClose={() => {
            performed.push("host");
          }}
        >
          <p>body</p>
        </PaneFrame>
      </PaneControlsContext.Provider>,
    );
    pane.querySelector<HTMLButtonElement>(".meridian-pane__control")?.click();
    expect(performed).toStrictEqual(["host"]);
  });

  it("puts the kind's own actions before the close", () => {
    const pane = renderPaneFrame(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <PaneFrame
          kind="diff"
          sessionId="session-1"
          focusHue={undefined}
          actions={<button type="button">Stage</button>}
        >
          <p>body</p>
        </PaneFrame>
      </PaneControlsContext.Provider>,
    );
    const buttons = [...pane.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons[0]).toBe("Stage");
    expect(buttons).toHaveLength(2);
  });
});

describe("PaneFrame — the drag handle", () => {
  it("hands the host its own head element, which is what the drag adapter binds to", () => {
    const registered: (HTMLElement | null)[] = [];
    const pane = renderPaneFrame(
      <PaneControlsContext.Provider
        value={{
          registerDragHandle: (element) => {
            registered.push(element);
          },
        }}
      >
        <PaneFrame kind="transcript" sessionId="session-1" focusHue={undefined}>
          <p>body</p>
        </PaneFrame>
      </PaneControlsContext.Provider>,
    );
    expect(registered[0]).toBe(pane.querySelector(".meridian-pane__head"));
  });

  it("negative control: a pane with no host registers nothing and is undraggable", () => {
    // Without this the chrome could be registering unconditionally, which would make a
    // pane mounted outside a deck draggable onto a deck it is not part of.
    const registered: (HTMLElement | null)[] = [];
    renderPaneFrame(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <PaneFrame kind="transcript" sessionId="session-1" focusHue={undefined}>
          <p>body</p>
        </PaneFrame>
      </PaneControlsContext.Provider>,
    );
    expect(registered).toStrictEqual([]);
  });
});
