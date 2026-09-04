// The frame every pane wears, and the two tables that have to stay total.
//
// The claims worth a unit are the ones a screenshot cannot make: that the glyph and
// the title tables answer for EVERY member of the closed pane-kind set (a lookup
// that fell through would render a nameless frame in whichever deck first opened
// that kind), that the breadcrumb ends on the pane rather than on its scope, and
// that an unattributed pane takes the neutral ring instead of borrowing a hue.
//
// The kind set is driven rather than listed: a twelfth kind added to `PANE_KINDS`
// has to fail here, and a test carrying its own copy of eleven names would pass.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PANE_KINDS } from "../seats/index.js";
import { ConsolePaneChrome, paneScopeCrumbs } from "./pane-chrome.js";

function renderChrome(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const pane = container.querySelector(".meridian-pane");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("the chrome rendered no pane element");
  }
  return pane;
}

describe("ConsolePaneChrome — every declared kind has a frame", () => {
  it("names and draws every pane kind", () => {
    for (const kind of PANE_KINDS) {
      const pane = renderChrome(
        <ConsolePaneChrome kind={kind} leadingCrumbs={["Session"]} focusHue={undefined}>
          <p>body</p>
        </ConsolePaneChrome>,
      );
      const crumbs = [...pane.querySelectorAll(".meridian-pane__crumb")].map(
        (crumb) => crumb.textContent,
      );
      // Two crumbs: the scope it was given, then the pane's own title — which is
      // appended by the chrome so no caller can spell it a second way.
      expect(crumbs).toHaveLength(2);
      expect(crumbs[1]).not.toBe("");
      expect(crumbs[1]).not.toBe(kind);
      expect(pane.querySelector(".meridian-pane__kind svg")).not.toBeNull();
      expect(pane.getAttribute("aria-label")).toBe(crumbs.join(" — "));
    }
  });

  it("marks the pane's own crumb as the current one, and no other", () => {
    const pane = renderChrome(
      <ConsolePaneChrome kind="runs" leadingCrumbs={["Session", "run run-10"]} focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    const current = [...pane.querySelectorAll('[aria-current="page"]')].map(
      (crumb) => crumb.textContent,
    );
    expect(current).toStrictEqual(["Runs"]);
  });

  it("negative control: a leading crumb is not marked current", () => {
    // Without this, the case above would pass over a chrome that marked every
    // crumb, because `toStrictEqual` on a one-element list would still be read
    // from a longer one only if the extra entries were absent — and they are the
    // thing being claimed absent.
    const pane = renderChrome(
      <ConsolePaneChrome kind="runs" leadingCrumbs={["Session"]} focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    const crumbs = [...pane.querySelectorAll(".meridian-pane__crumb")];
    expect(crumbs[0]?.getAttribute("aria-current")).toBeNull();
    expect(crumbs[1]?.getAttribute("aria-current")).toBe("page");
  });
});

describe("ConsolePaneChrome — the focus ring is attributed or neutral, never guessed", () => {
  it("carries an attributed pane's hue into the ring", () => {
    const pane = renderChrome(
      <ConsolePaneChrome
        kind="inspector"
        leadingCrumbs={["Session"]}
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
    // Fail-closed: the stylesheet's own fallback is the neutral ring, and an
    // unattributed pane must reach it by carrying NO custom property rather than
    // by carrying someone else's.
    const pane = renderChrome(
      <ConsolePaneChrome kind="inspector" leadingCrumbs={["Session"]} focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(pane.style.getPropertyValue("--meridian-pane-hue")).toBe("");
  });

  it("is reachable programmatically without spending a tab stop", () => {
    const pane = renderChrome(
      <ConsolePaneChrome kind="approvals" leadingCrumbs={["Session"]} focusHue={undefined}>
        <p>body</p>
      </ConsolePaneChrome>,
    );
    expect(pane.tabIndex).toBe(-1);
    pane.focus();
    expect(document.activeElement).toBe(pane);
  });
});

describe("paneScopeCrumbs — a session-scoped pane names the session, not `undefined`", () => {
  it("names the session alone when the deck addressed no entity", () => {
    expect(paneScopeCrumbs(undefined)).toStrictEqual(["Session"]);
  });

  it("names the entity wire-verbatim beneath the session", () => {
    expect(paneScopeCrumbs({ kind: "run", id: "run-10" })).toStrictEqual(["Session", "run run-10"]);
  });

  it("negative control: the two answers differ", () => {
    // Both cases above would pass over a helper that ignored its argument and
    // always answered `["Session"]`.
    expect(paneScopeCrumbs({ kind: "run", id: "run-10" })).not.toStrictEqual(
      paneScopeCrumbs(undefined),
    );
  });
});
