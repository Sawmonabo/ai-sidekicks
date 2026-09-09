// What the HOST hands a pane: its two controls, and the element a drag binds to.
//
// Its own file rather than two more suites beside the frame's, because it is a different
// subject and the two together were past the package's ceiling. Everything here arrives
// from outside the chrome — through `PaneControlsContext`, which the deck provides around
// every pane body, or through an explicit prop, which is how a host that owns one pane's
// lifetime outside a deck keeps its close button pointed at the right thing.
//
// The claims are about ABSENCE as much as presence: a control drawn disabled instead of
// absent looks deliberate, a detach button on a kind the window model has no route for
// asks for a window nobody can open, and a context that silently loses to an explicit
// prop — or wins over it — is a difference nobody sees until a pane is mounted outside a
// deck.

import { describe, expect, it } from "vitest";

import { ConsolePaneChrome } from "./ConsolePaneChrome.js";
import { renderChrome } from "./ConsolePaneChrome.test-support.js";
import { PaneControlsContext } from "./pane-controls.js";
import { PANE_KINDS, isDetachablePaneKind } from "./pane-kinds.js";

function controlLabels(pane: HTMLElement): readonly (string | null)[] {
  return [...pane.querySelectorAll(".meridian-pane__control")].map((control) =>
    control.getAttribute("aria-label"),
  );
}

describe("ConsolePaneChrome — where the controls come from", () => {
  it("draws neither control when nobody can perform either act", () => {
    const pane = renderChrome(
      <ConsolePaneChrome kind="timeline" sessionId="session-1" focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(controlLabels(pane)).toStrictEqual([]);
  });

  it("takes both from the deck's context, labelled with the pane's own noun", () => {
    const pane = renderChrome(
      <PaneControlsContext.Provider
        value={{ onClose: () => undefined, onOpenInWindow: () => undefined }}
      >
        <ConsolePaneChrome kind="timeline" sessionId="session-1" focusHue={undefined}>
          <p>body</p>
        </ConsolePaneChrome>
      </PaneControlsContext.Provider>,
    );
    expect(controlLabels(pane)).toStrictEqual([
      "Open this timeline in its own window",
      "Close this pane",
    ]);
  });

  it("draws the detach control only for a kind the window model can open", () => {
    // THE GATE. A deck supplies its controls through ONE context, so a host doing the
    // ordinary thing hands every pane it lays out the same `onOpenInWindow`. Keyed on
    // the handler alone that put a detach button on a `runs` pane, whose act the window
    // model has no route to serve. Driven over the whole closed kind set rather than
    // asserted for two names, so a kind added to the auxiliary routes is covered here
    // without an edit and a kind quietly dropped from them fails.
    const bothOffered = { onClose: () => undefined, onOpenInWindow: () => undefined };
    const detachable: string[] = [];
    const withheld: string[] = [];
    for (const kind of PANE_KINDS) {
      const pane = renderChrome(
        <PaneControlsContext.Provider value={bothOffered}>
          <ConsolePaneChrome kind={kind} sessionId="session-1" focusHue={undefined}>
            <p>body</p>
          </ConsolePaneChrome>
        </PaneControlsContext.Provider>,
      );
      const labels = controlLabels(pane);
      // The close is offered to every kind, so its presence is what proves the handler
      // reached the chrome at all and the detach was withheld rather than both lost.
      expect(labels, `${kind} lost the close control`).toContain("Close this pane");
      (labels.length === 2 ? detachable : withheld).push(kind);
    }
    expect(detachable).toStrictEqual([...PANE_KINDS].filter(isDetachablePaneKind));
    expect(withheld).toStrictEqual([...PANE_KINDS].filter((kind) => !isDetachablePaneKind(kind)));
    // Both sides have members, or the claim above holds over an arrangement that
    // proves nothing — every kind detachable, or none.
    expect(detachable.length).toBeGreaterThan(0);
    expect(withheld.length).toBeGreaterThan(0);
  });

  it("withholds it from an explicit prop too, not only from the context", () => {
    // The other door. Explicit wins over the context for the close, so a gate applied
    // to one path and not the other would leave a non-deck host able to draw the
    // button the deck path refuses.
    const runs = renderChrome(
      <ConsolePaneChrome
        kind="runs"
        sessionId="session-1"
        focusHue={undefined}
        onOpenInWindow={() => undefined}
        onClose={() => undefined}
      >
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(controlLabels(runs)).toStrictEqual(["Close this pane"]);

    const timeline = renderChrome(
      <ConsolePaneChrome
        kind="timeline"
        sessionId="session-1"
        focusHue={undefined}
        onOpenInWindow={() => undefined}
        onClose={() => undefined}
      >
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(controlLabels(timeline)).toStrictEqual([
      "Open this timeline in its own window",
      "Close this pane",
    ]);
  });

  it("draws only what the context actually offers", () => {
    // A deck whose registry says this kind cannot be torn off provides the close alone,
    // and the chrome must not invent the other control from its presence.
    const pane = renderChrome(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <ConsolePaneChrome kind="terminal" sessionId="session-1" focusHue={undefined}>
          <p>body</p>
        </ConsolePaneChrome>
      </PaneControlsContext.Provider>,
    );
    expect(controlLabels(pane)).toStrictEqual(["Close this pane"]);
  });

  it("lets an explicit prop win over the context, so a non-deck host keeps its pane", () => {
    const performed: string[] = [];
    const pane = renderChrome(
      <PaneControlsContext.Provider
        value={{
          onClose: () => {
            performed.push("deck");
          },
        }}
      >
        <ConsolePaneChrome
          kind="timeline"
          sessionId="session-1"
          focusHue={undefined}
          onClose={() => {
            performed.push("host");
          }}
        >
          <p>body</p>
        </ConsolePaneChrome>
      </PaneControlsContext.Provider>,
    );
    pane.querySelector<HTMLButtonElement>(".meridian-pane__control")?.click();
    expect(performed).toStrictEqual(["host"]);
  });

  it("puts the kind's own actions before the two host controls", () => {
    const pane = renderChrome(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <ConsolePaneChrome
          kind="diff"
          sessionId="session-1"
          focusHue={undefined}
          actions={<button type="button">Stage</button>}
        >
          <p>body</p>
        </ConsolePaneChrome>
      </PaneControlsContext.Provider>,
    );
    const buttons = [...pane.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons[0]).toBe("Stage");
    expect(buttons).toHaveLength(2);
  });
});

describe("ConsolePaneChrome — the drag handle", () => {
  it("hands the host its own head element, which is what the drag adapter binds to", () => {
    const registered: (HTMLElement | null)[] = [];
    const pane = renderChrome(
      <PaneControlsContext.Provider
        value={{
          registerDragHandle: (element) => {
            registered.push(element);
          },
        }}
      >
        <ConsolePaneChrome kind="timeline" sessionId="session-1" focusHue={undefined}>
          <p>body</p>
        </ConsolePaneChrome>
      </PaneControlsContext.Provider>,
    );
    expect(registered[0]).toBe(pane.querySelector(".meridian-pane__head"));
  });

  it("negative control: a pane with no host registers nothing and is undraggable", () => {
    // Without this the chrome could be registering unconditionally, which would make
    // the auxiliary window's single pane draggable onto a deck it is not part of.
    const registered: (HTMLElement | null)[] = [];
    renderChrome(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <ConsolePaneChrome kind="timeline" sessionId="session-1" focusHue={undefined}>
          <p>body</p>
        </ConsolePaneChrome>
      </PaneControlsContext.Provider>,
    );
    expect(registered).toStrictEqual([]);
  });
});
