// What the sidekicks page may and may not say while it has no wire.
//
// Three properties, and each of them is a way the page could go wrong quietly:
// it could show an empty list and assert a fact nobody established; it could draw
// controls whose verbs do not exist; and it could put the reserved seat's
// governance prose on a screen. The rest of the file is the teaching copy, which is
// the only thing on the page that is true without asking anything.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidekickDefinitionsPage } from "./DefinitionsPage.js";

/** The saved-sidekicks region, by its accessible name rather than by position. */
function savedRegionOf(container: HTMLElement): Element {
  const region = container.querySelector('[aria-label="Saved sidekicks"]');
  if (region === null) {
    throw new Error("the page rendered no saved-sidekicks region");
  }
  return region;
}

describe("the sidekicks page — the saved list it cannot read", () => {
  it("says nobody asked, rather than showing the list empty", () => {
    // Rule 8's fourth absence. "No question was put" and "there are none" are
    // different facts, and only one of them is true here: no read for a saved
    // sidekick is registered anywhere in this repository.
    const { container } = render(<SidekickDefinitionsPage />);
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(saved.textContent ?? "").toContain("have not been read");
  });

  it("negative control: it is not the empty absence, and it is not a list", () => {
    // Without this, the case above would pass over a page that rendered the empty
    // treatment beside the not-checked one, or that projected rows from a shape it
    // invented. Both are the conflation rule 8 exists to forbid.
    const { container } = render(<SidekickDefinitionsPage />);
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(saved.querySelector("ul, ol, table")).toBeNull();
  });

  it("counts nothing, because no read joins a saved sidekick to what was attached from it", () => {
    // A usage tally would be a second source of truth for a question nothing on
    // this machine answers.
    const { container } = render(<SidekickDefinitionsPage />);
    expect(container.querySelector(".meridian-figure--derived")).toBeNull();
  });
});

describe("the sidekicks page — the controls it declines to draw", () => {
  it("offers no action at all, because every verb behind one is unregistered", () => {
    // A control whose verb is not registered is not drawn. A create button here
    // could only ever fail, and a button that can only fail is worse than none.
    const { container } = render(<SidekickDefinitionsPage />);
    expect(container.querySelector("button, input, select, textarea, a[href]")).toBeNull();
  });

  it("negative control: the page is not simply blank", () => {
    // Without this, the case above would pass over a page that rendered nothing,
    // which is a different failure wearing the same result.
    const { container } = render(<SidekickDefinitionsPage />);
    expect((container.textContent ?? "").length).toBeGreaterThan(200);
  });
});

describe("the sidekicks page — the facts it teaches without asking anything", () => {
  it("states exactly the three a person needs before tuning one", () => {
    const { container } = render(<SidekickDefinitionsPage />);
    expect(container.querySelectorAll(".meridian-sidekicks__rule")).toHaveLength(3);
  });

  it("says a rename reaches nothing running, and that editing is therefore safe", () => {
    // The two rules people get wrong about a registry like this one: that the name
    // identifies the record, and that editing it reaches the sidekicks attached
    // from it. Both are false, and the page says so where the records will be.
    const { container } = render(<SidekickDefinitionsPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("A name is a label, not an identifier");
    expect(text).toContain("Nothing already attached");
  });

  it("negative control: it does not claim a saved sidekick controls a running one", () => {
    // Without this, the case above would pass over a page that stated the snapshot
    // rule and then contradicted it — the claim the design forbids in terms.
    const { container } = render(<SidekickDefinitionsPage />);
    expect(container.textContent ?? "").not.toMatch(/\bcontrol(?:s|ling)\b/iu);
  });

  it("promises no sharing, sync, or export, because the records never leave this machine", () => {
    const { container } = render(<SidekickDefinitionsPage />);
    expect(container.textContent ?? "").toContain("no sharing, no sync, and nothing to export");
  });
});

describe("the sidekicks page — the editor's seat", () => {
  it("states the absence rather than drawing a form", () => {
    const { container } = render(<SidekickDefinitionsPage />);
    const detail = container.querySelector('[aria-label="Sidekick detail"]');
    expect(detail?.textContent ?? "").toContain("sidekick editor has not been built here yet");
  });

  it("names no governance work anywhere a person can read", () => {
    // Repository-wide: governance identifiers live in comments, never in a string a
    // participant reads. The seat's contract carries three of them and is
    // developer-facing for exactly that reason.
    const { container } = render(<SidekickDefinitionsPage />);
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });
});
