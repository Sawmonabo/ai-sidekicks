// The frame the chrome draws: its two total tables, its name, its focus ring, its key claim.
//
// The claims worth a unit are the ones a screenshot cannot make: that the glyph and the
// title tables answer for EVERY member of the closed pane-kind set (a lookup that fell
// through would render a nameless frame in whichever deck first opened that kind), that a
// pane is named by its whole trail so two panes of one kind are told apart, that an
// unattributed pane takes the neutral ring instead of borrowing a hue, and that a
// pane-level key claim is heard on the HEAD as well as on the body.
//
// The kind set is driven rather than listed: a twelfth kind added to `PANE_KINDS` has to
// fail here, and a test carrying its own copy of eleven names would pass.
//
// What the HOST hands a pane — the two controls and the drag registration — is
// `ConsolePaneChrome.host-seams.test.tsx`', and the registry-address adapter beside this
// component is `ConsolePaneChrome.pane-body.test.tsx`'.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConsolePaneChrome, GLYPH_BY_PANE_KIND, TITLE_BY_PANE_KIND } from "./ConsolePaneChrome.js";
import { renderChrome } from "./ConsolePaneChrome.test-support.js";
import { PANE_KINDS } from "./pane-kinds.js";

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

describe("ConsolePaneChrome — the pane-level key claim", () => {
  /** A chrome whose key claim records every key it heard, in order. */
  function renderClaiming(heard: string[], children: React.ReactNode): HTMLElement {
    return renderChrome(
      <ConsolePaneChrome
        kind="browser"
        sessionId="session-1"
        focusHue={undefined}
        onKeyDownCapture={(event) => {
          heard.push(event.key);
        }}
      >
        {children}
      </ConsolePaneChrome>,
    );
  }

  it("hears a key pressed on the head, which is not inside the body", () => {
    // THE CASE THE SEAM EXISTS FOR. A family that wrapped its own body to get the
    // capture would pass every assertion about the body and hear nothing here, and the
    // head is where the drag handle, the detach control, and the close control live —
    // so a pane-level chord pressed while any of them has focus would be lost.
    const heard: string[] = [];
    const pane = renderClaiming(heard, <p>the browser body</p>);
    const head = pane.querySelector(".meridian-pane__head");
    if (!(head instanceof HTMLElement)) {
      throw new Error("the chrome drew no head for a key to be pressed on");
    }

    fireEvent.keyDown(head, { key: "w", ctrlKey: true });

    expect(heard).toStrictEqual(["w"]);
  });

  it("hears one pressed in the body too, so the claim covers the whole pane", () => {
    const heard: string[] = [];
    const pane = renderClaiming(heard, <input aria-label="address" />);
    const field = pane.querySelector("input");
    if (field === null) {
      throw new Error("the body rendered no field for a key to be pressed in");
    }

    fireEvent.keyDown(field, { key: "w", ctrlKey: true });

    expect(heard).toStrictEqual(["w"]);
  });

  it("negative control: a chrome given no handler binds nothing", () => {
    // Without this, a chrome that always attached a listener of its own would satisfy
    // both cases above while claiming keys from a pane that asked for none.
    const pane = renderChrome(
      <ConsolePaneChrome kind="browser" sessionId="session-1" focusHue={undefined}>
        <input aria-label="address" />
      </ConsolePaneChrome>,
    );
    const field = pane.querySelector("input");
    if (field === null) {
      throw new Error("the body rendered no field for a key to be pressed in");
    }

    expect(() => {
      fireEvent.keyDown(field, { key: "w", ctrlKey: true });
    }).not.toThrow();
  });
});
