// The one header, and the two ways a pane gets its controls.
//
// The claims that fail invisibly: a control drawn disabled instead of absent looks
// deliberate in a screenshot, and a context that silently loses to an explicit prop
// (or wins over it) is a difference nobody sees until a host mounts a pane outside
// a deck and its close button closes the wrong thing.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PANE_KINDS } from "../../seats/index.js";
import { PANE_KIND_GLYPHS, PaneHeader } from "./PaneHeader.js";
import { PaneControlsContext } from "./pane-controls.js";

function renderHeader(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const header = container.querySelector(".meridian-pane__header");
  if (!(header instanceof HTMLElement)) {
    throw new Error("PaneHeader rendered no header element");
  }
  return header;
}

function controlLabels(header: HTMLElement): readonly (string | null)[] {
  return [...header.querySelectorAll(".meridian-pane__control")].map((control) =>
    control.getAttribute("aria-label"),
  );
}

describe("PaneHeader — the glyph table", () => {
  it("names a glyph for every pane kind, so no kind falls back to a default", () => {
    expect(Object.keys(PANE_KIND_GLYPHS).sort()).toStrictEqual([...PANE_KINDS].sort());
  });
});

describe("PaneHeader — the breadcrumb", () => {
  it("renders the address it was given, in order, and leaves out what it was not", () => {
    // Every crumb carries a DISTINCT id on purpose. Two crumbs sharing a string
    // cannot witness "in order" — the assertion holds over either arrangement —
    // and the breadcrumb keys each crumb by its own text, so a repeated one is
    // also a duplicate React key.
    const header = renderHeader(
      <PaneHeader
        kind="inspector"
        title="Inspector"
        headingId="heading-1"
        sessionId="session-1"
        runId="run-01"
        entity={{ kind: "agent", id: "agent-01" }}
      />,
    );
    expect(
      [...header.querySelectorAll(".meridian-pane__crumb")].map((c) => c.textContent),
    ).toStrictEqual(["session-1", "run-01", "agent-01"]);
  });

  it("says the address names nothing rather than rendering an empty strip", () => {
    const header = renderHeader(
      <PaneHeader
        kind="timeline"
        title="Timeline"
        headingId="heading-1"
        sessionId={undefined}
        entity={undefined}
      />,
    );
    expect(header.querySelector(".meridian-pane__crumb-absent")?.textContent).toBe("No session");
  });
});

describe("PaneHeader — where the controls come from", () => {
  it("draws neither control when nobody can perform either act", () => {
    const header = renderHeader(
      <PaneHeader
        kind="timeline"
        title="Timeline"
        headingId="heading-1"
        sessionId="session-1"
        entity={undefined}
      />,
    );
    expect(controlLabels(header)).toStrictEqual([]);
  });

  it("takes both from the deck's context, labelled with the pane's own noun", () => {
    const header = renderHeader(
      <PaneControlsContext.Provider
        value={{ onClose: () => undefined, onOpenInWindow: () => undefined }}
      >
        <PaneHeader
          kind="timeline"
          title="Timeline"
          headingId="heading-1"
          sessionId="session-1"
          entity={undefined}
        />
      </PaneControlsContext.Provider>,
    );
    expect(controlLabels(header)).toStrictEqual([
      "Open this timeline in its own window",
      "Close this pane",
    ]);
  });

  it("draws only what the context actually offers", () => {
    // A deck whose registry says this kind cannot be torn off provides the close
    // alone, and the header must not invent the other control from its presence.
    const header = renderHeader(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <PaneHeader
          kind="terminal"
          title="Terminal"
          headingId="heading-1"
          sessionId="session-1"
          entity={undefined}
        />
      </PaneControlsContext.Provider>,
    );
    expect(controlLabels(header)).toStrictEqual(["Close this pane"]);
  });

  it("lets an explicit prop win over the context, so a non-deck host keeps its pane", () => {
    const performed: string[] = [];
    const header = renderHeader(
      <PaneControlsContext.Provider
        value={{
          onClose: () => {
            performed.push("deck");
          },
        }}
      >
        <PaneHeader
          kind="timeline"
          title="Timeline"
          headingId="heading-1"
          sessionId="session-1"
          entity={undefined}
          onClose={() => {
            performed.push("host");
          }}
        />
      </PaneControlsContext.Provider>,
    );
    const close = header.querySelector<HTMLButtonElement>(".meridian-pane__control");
    close?.click();
    expect(performed).toStrictEqual(["host"]);
  });

  it("puts the kind's own actions before the two host controls", () => {
    const header = renderHeader(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <PaneHeader
          kind="diff"
          title="Diff"
          headingId="heading-1"
          sessionId="session-1"
          entity={undefined}
          actions={<button type="button">Stage</button>}
        />
      </PaneControlsContext.Provider>,
    );
    const buttons = [...header.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons[0]).toBe("Stage");
    expect(buttons).toHaveLength(2);
  });
});

describe("PaneHeader — the drag handle", () => {
  it("hands the host its own header element, which is what the drag adapter binds to", () => {
    const registered: (HTMLElement | null)[] = [];
    const header = renderHeader(
      <PaneControlsContext.Provider
        value={{
          registerDragHandle: (element) => {
            registered.push(element);
          },
        }}
      >
        <PaneHeader
          kind="timeline"
          title="Timeline"
          headingId="heading-1"
          sessionId="session-1"
          entity={undefined}
        />
      </PaneControlsContext.Provider>,
    );
    expect(registered[0]).toBe(header);
  });

  it("negative control: a header with no host registers nothing and is undraggable", () => {
    // Without this the header could be registering unconditionally, which would make
    // the auxiliary window's single pane draggable onto a deck it is not part of.
    const registered: (HTMLElement | null)[] = [];
    renderHeader(
      <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
        <PaneHeader
          kind="timeline"
          title="Timeline"
          headingId="heading-1"
          sessionId="session-1"
          entity={undefined}
        />
      </PaneControlsContext.Provider>,
    );
    expect(registered).toStrictEqual([]);
  });
});
