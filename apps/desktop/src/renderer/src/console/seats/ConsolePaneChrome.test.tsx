// The one frame every pane wears, the two tables that have to stay total, and the two
// ways a pane gets its controls.
//
// The claims worth a unit are the ones a screenshot cannot make: that the glyph and the
// title tables answer for EVERY member of the closed pane-kind set (a lookup that fell
// through would render a nameless frame in whichever deck first opened that kind), that
// an unattributed pane takes the neutral ring instead of borrowing a hue, that a control
// drawn disabled instead of absent looks deliberate, and that a context which silently
// loses to an explicit prop — or wins over it — is a difference nobody sees until a host
// mounts a pane outside a deck and its close button closes the wrong thing.
//
// The kind set is driven rather than listed: a twelfth kind added to `PANE_KINDS` has to
// fail here, and a test carrying its own copy of eleven names would pass.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ConsolePaneChrome,
  GLYPH_BY_PANE_KIND,
  TITLE_BY_PANE_KIND,
  paneBodyForKind,
} from "./ConsolePaneChrome.js";
import { PaneControlsContext } from "./pane-controls.js";
import { PANE_KINDS, isDetachablePaneKind } from "./pane-kinds.js";
import { type ConsolePaneContext } from "./pane-registry.js";

function renderChrome(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const pane = container.querySelector(".meridian-pane");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("the chrome rendered no pane element");
  }
  return pane;
}

function controlLabels(pane: HTMLElement): readonly (string | null)[] {
  return [...pane.querySelectorAll(".meridian-pane__control")].map((control) =>
    control.getAttribute("aria-label"),
  );
}

/** The element the pane names itself by, resolved the way an assistive reader does. */
function accessibleName(pane: HTMLElement): string {
  const labelledBy = pane.getAttribute("aria-labelledby");
  if (labelledBy === null) {
    throw new Error("the pane names itself by nothing");
  }
  const naming = pane.ownerDocument.getElementById(labelledBy);
  if (naming === null) {
    throw new Error(`the pane names itself by "${labelledBy}", which is on no element`);
  }
  return naming.textContent ?? "";
}

describe("ConsolePaneChrome — every declared kind has a frame", () => {
  it("names a glyph and a title for every pane kind, so no kind falls back", () => {
    expect(Object.keys(GLYPH_BY_PANE_KIND).sort()).toStrictEqual([...PANE_KINDS].sort());
    expect(Object.keys(TITLE_BY_PANE_KIND).sort()).toStrictEqual([...PANE_KINDS].sort());
  });

  it("names and draws every pane kind", () => {
    for (const kind of PANE_KINDS) {
      const pane = renderChrome(
        <ConsolePaneChrome
          kind={kind}
          sessionId="session-1"
          entity={undefined}
          focusHue={undefined}
        >
          <p>body</p>
        </ConsolePaneChrome>,
      );
      const crumbs = [...pane.querySelectorAll("li")].map((crumb) => crumb.textContent);
      // Two crumbs: the session it was addressed at, then the pane's own name — which
      // the chrome supplies, so no caller can spell it a second way.
      expect(crumbs, kind).toStrictEqual(["session-1", TITLE_BY_PANE_KIND[kind]]);
      expect(crumbs[1], kind).not.toBe(kind);
      expect(pane.querySelector(".meridian-pane__kind svg"), kind).not.toBeNull();
      expect(pane.className, kind).toContain(`meridian-pane--${kind}`);
    }
  });

  it("negative control: the two tables are not one table", () => {
    // Without this, "every kind has a title" would also be satisfied by a table that
    // answered the wire-shaped kind string for every entry, which is exactly what the
    // title table exists not to be.
    expect(TITLE_BY_PANE_KIND["workflow-run"]).toBe("Workflow run");
    expect(Object.values(TITLE_BY_PANE_KIND)).not.toContain("workflow-run");
  });
});

describe("ConsolePaneChrome — how the pane names itself", () => {
  it("is named by its whole trail, so two panes of one kind differ", () => {
    const runsPane = renderChrome(
      <ConsolePaneChrome kind="runs" sessionId="session-1" runId="run-01" focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(accessibleName(runsPane)).toContain("session-1");
    expect(accessibleName(runsPane)).toContain("run-01");
    expect(accessibleName(runsPane)).toContain("Runs");
  });

  it("negative control: two runs panes at different addresses are named differently", () => {
    // Without this the case above would pass over a chrome named by its title alone,
    // which is the state a deck full of `runs` panes is unnavigable in.
    const first = renderChrome(
      <ConsolePaneChrome kind="runs" sessionId="session-1" runId="run-01" focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    const second = renderChrome(
      <ConsolePaneChrome kind="runs" sessionId="session-1" runId="run-02" focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(accessibleName(first)).not.toBe(accessibleName(second));
  });

  it("mints its own id when the caller has none to give", () => {
    const pane = renderChrome(
      <ConsolePaneChrome kind="diff" sessionId="session-1" focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(pane.getAttribute("aria-labelledby")).not.toBe("");
    expect(accessibleName(pane)).toContain("Diff");
  });

  it("takes the caller's id where the caller owns one", () => {
    const pane = renderChrome(
      <ConsolePaneChrome
        kind="diff"
        headingId="host-owned-heading"
        sessionId="session-1"
        focusHue={undefined}
      >
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(pane.getAttribute("aria-labelledby")).toBe("host-owned-heading");
  });

  it("negative control: two minted ids do not collide", () => {
    // Two panes of one kind in one deck is the common case, and a literal id would
    // point both `aria-labelledby` references at whichever element rendered first.
    const { container } = render(
      <>
        <ConsolePaneChrome kind="runs" sessionId="session-1" focusHue={undefined}>
          <p>one</p>
        </ConsolePaneChrome>
        <ConsolePaneChrome kind="runs" sessionId="session-2" focusHue={undefined}>
          <p>two</p>
        </ConsolePaneChrome>
      </>,
    );
    const ids = [...container.querySelectorAll(".meridian-pane")].map((pane) =>
      pane.getAttribute("aria-labelledby"),
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("ConsolePaneChrome — the focus treatments are attributed or neutral, never guessed", () => {
  it("carries an attributed pane's hue", () => {
    const pane = renderChrome(
      <ConsolePaneChrome
        kind="inspector"
        sessionId="session-1"
        focusHue="var(--meridian-participant-hue-3)"
      >
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(pane.style.getPropertyValue("--meridian-pane-hue")).toBe(
      "var(--meridian-participant-hue-3)",
    );
  });

  it("sets no hue at all when the deck has nobody to attribute the pane to", () => {
    // Fail-closed: the stylesheet's own fallbacks are the neutral ring and the neutral
    // boundary, and an unattributed pane must reach them by carrying NO custom property
    // rather than by carrying someone else's.
    const pane = renderChrome(
      <ConsolePaneChrome kind="inspector" sessionId="session-1" focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(pane.style.getPropertyValue("--meridian-pane-hue")).toBe("");
  });

  it("is reachable programmatically without spending a tab stop", () => {
    const pane = renderChrome(
      <ConsolePaneChrome kind="approvals" sessionId="session-1" focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(pane.tabIndex).toBe(-1);
    pane.focus();
    expect(pane.ownerDocument.activeElement).toBe(pane);
  });
});

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

describe("paneBodyForKind — a mismatched address is refused, not thrown", () => {
  /**
   * A context carrying only what the adapter reads.
   *
   * The adapter compares `context.kind` and hands the whole value on. Building a
   * bridge, a frame store, three persistence stores, and a session store to prove a
   * string comparison would be a fixture testing the fixture, and the cast is what says
   * so out loud rather than hiding behind a builder.
   */
  function addressedAt(kind: ConsolePaneContext["kind"]): ConsolePaneContext {
    return { kind } as unknown as ConsolePaneContext;
  }

  it("renders the body when the address is the kind it was written for", () => {
    const body = paneBodyForKind("runs", () => <p>the runs body</p>);
    const { container } = render(<>{body(addressedAt("runs"))}</>);
    expect(container.textContent).toBe("the runs body");
  });

  it("refuses in place when the address is another kind's", () => {
    const body = paneBodyForKind("runs", () => <p>the runs body</p>);
    const { container } = render(<>{body(addressedAt("diff"))}</>);
    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
    expect(container.textContent).toContain("pane-composition.pane-kind-mismatch");
    // Named in the words the pane is called everywhere else, and naming what it was
    // actually handed — a refusal that said neither is a refusal nobody can act on.
    expect(container.textContent).toContain("Runs");
    expect(container.textContent).toContain("diff");
  });

  it("negative control: the mismatch arm is a render and not a throw", () => {
    // A throw here would take the whole window down for one bad row in a restored
    // layout, which is the disposition `core/refusal.ts` exists to forbid.
    const body = paneBodyForKind("inspector", () => <p>the inspector body</p>);
    expect(() => body(addressedAt("artifact"))).not.toThrow();
  });

  it("negative control: the matched arm draws no refusal", () => {
    // Without this, "refuses on a mismatch" would also be satisfied by an adapter that
    // refused on everything.
    const body = paneBodyForKind("inspector", () => <p>the inspector body</p>);
    const { container } = render(<>{body(addressedAt("inspector"))}</>);
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });
});
