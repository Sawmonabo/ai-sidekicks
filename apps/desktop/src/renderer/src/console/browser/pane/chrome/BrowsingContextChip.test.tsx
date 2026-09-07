// The context chip over all four readings, because the fourth is what it got wrong.
//
// `null` is two facts on this surface: the wire's value for a served context nobody
// named, and — before this suite — whatever the chip showed while the page-list
// subscription was pending, refused, or ended. The chip said "Unnamed context" for
// both, so a strip whose subscription had been refused reported, persistently, that
// an agent had set no context name. That is rule 8's collapse: an absence rendered as
// an answer.
//
// So every arm is asserted, and each is asserted to EXCLUDE the others' words. A chip
// that fell back to one sentence for three readings would pass a suite that only
// checked the sentence it fell back to.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import type { PageListReading } from "../page-state.js";
import { threeBrowserPages } from "../page-state.test-support.js";
import { BrowsingContextChip } from "./BrowsingContextChip.js";

/** The served arm with whatever name the frame carries, and no pages to distract. */
function servedContext(contextName: string | null): PageListReading {
  return { kind: "served", frame: { contextName, pages: [] } };
}

/** The chip's own element, so a case can read the class the stylesheet keys on. */
function chip(): HTMLElement {
  const element = document.querySelector(".meridian-browser-tabs__context");
  if (!(element instanceof HTMLElement)) {
    throw new Error("the strip drew no context chip");
  }
  return element;
}

describe("the browsing-context chip", () => {
  it("renders the name a served frame carries", () => {
    render(<BrowsingContextChip reading={threeBrowserPages()} />);
    expect(screen.getByText("Research")).toBeTruthy();
    expect(chip().className).not.toContain("--unnamed");
  });

  it("says the context is unnamed only for a served frame that named none", () => {
    render(<BrowsingContextChip reading={servedContext(null)} />);
    expect(screen.getByText("Unnamed context")).toBeTruthy();
    expect(chip().className).toContain("--unnamed");
  });

  it("treats an empty name as no name, since a blank chip names nothing", () => {
    render(<BrowsingContextChip reading={servedContext("")} />);
    expect(screen.getByText("Unnamed context")).toBeTruthy();
  });

  it("says nobody has answered yet while the read is in flight", () => {
    render(<BrowsingContextChip reading={{ kind: "reading" }} />);
    expect(screen.getByText("Context not read")).toBeTruthy();
    expect(screen.queryByText("Unnamed context")).toBeNull();
  });

  it("says nobody reported a context where the read was refused", () => {
    render(
      <BrowsingContextChip
        reading={{
          kind: "refused",
          scope: "whole-answer",
          refusal: refuse("browser-pages", "page-subscription-failed", "The subscription broke."),
        }}
      />,
    );
    expect(screen.getByText("Context not reported")).toBeTruthy();
    expect(screen.queryByText("Unnamed context")).toBeNull();
  });

  it("says the producer finished rather than that the context lost its name", () => {
    render(<BrowsingContextChip reading={{ kind: "ended" }} />);
    expect(screen.getByText("Context no longer reported")).toBeTruthy();
    expect(screen.queryByText("Unnamed context")).toBeNull();
  });

  it("draws an unreported context differently from an unnamed one", () => {
    // The two are different facts and the stylesheet has to be able to tell them
    // apart: one is a frame that arrived carrying no name, the other is no frame.
    render(<BrowsingContextChip reading={{ kind: "reading" }} />);
    expect(chip().className).toContain("--unreported");
    expect(chip().className).not.toContain("--unnamed");
  });
});
