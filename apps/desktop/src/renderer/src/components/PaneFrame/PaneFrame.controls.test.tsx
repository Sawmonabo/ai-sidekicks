// What the host hands a pane: its close control and the element a drag binds to, through
// `PaneControlsContext` or an explicit prop. Absence matters as much as presence: a disabled
// control looks deliberate, and context and prop must have a defined precedence.

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
      <PaneFrame kind="transcript" sessionId="session-1">
        <p>body</p>
      </PaneFrame>,
    );
    expect(controlLabels(pane)).toStrictEqual([]);
  });

  it("takes the close from the pane layout's context", () => {
    const pane = renderPaneFrame(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <PaneFrame kind="transcript" sessionId="session-1">
          <p>body</p>
        </PaneFrame>
      </PaneControlsContext.Provider>,
    );
    expect(controlLabels(pane)).toStrictEqual(["Close this pane"]);
  });

  it("lets an explicit prop win over the context, so a non-pane-layout host keeps its pane", () => {
    const performed: string[] = [];
    const pane = renderPaneFrame(
      <PaneControlsContext.Provider
        value={{
          onClose: () => {
            performed.push("context");
          },
        }}
      >
        <PaneFrame
          kind="transcript"
          sessionId="session-1"
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
        <PaneFrame kind="diff" sessionId="session-1" actions={<button type="button">Stage</button>}>
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
        <PaneFrame kind="transcript" sessionId="session-1">
          <p>body</p>
        </PaneFrame>
      </PaneControlsContext.Provider>,
    );
    expect(registered[0]).toBe(pane.querySelector(".meridian-pane__head"));
  });

  it("negative control: a pane with no host registers nothing and is undraggable", () => {
    // Negative control: unconditional registration would make a pane outside a pane layout
    // draggable.
    const registered: (HTMLElement | null)[] = [];
    renderPaneFrame(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <PaneFrame kind="transcript" sessionId="session-1">
          <p>body</p>
        </PaneFrame>
      </PaneControlsContext.Provider>,
    );
    expect(registered).toStrictEqual([]);
  });
});
