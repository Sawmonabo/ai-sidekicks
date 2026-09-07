// The overflow control: what is one click behind it, and what it says before it acts.
//
// The density rule 12.2 states has two halves, and the strip's suite covers the
// visible half. This covers the other: the regions a person reaches by opening it,
// each rendering its own absence rather than a blank, and the site-data control naming
// what it clears BEFORE it is armed — a control that named the scope only after the
// press would be telling a person what it did rather than what it will do.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import { recordingChromeActs, type RecordedChromeAct } from "./chrome-acts.test-support.js";
import type { HandbackBinding } from "../handback/handback-binding.js";
import { PaneOverflow, type PaneOverflowProps } from "./PaneOverflow.js";

/** A mirror that published, which is the state every case but the handback's assumes. */
const PUBLISHED_HANDBACK: HandbackBinding = {
  mirrorChords: ["mod+k", "mod+p"],
  refusal: undefined,
  replayCount: 3,
};

interface OverflowMount {
  readonly recorded: readonly RecordedChromeAct[];
  readonly onCapture: Mock<PaneOverflowProps["onCapture"]>;
}

function renderOverflow(handback: HandbackBinding = PUBLISHED_HANDBACK): OverflowMount {
  const { acts, recorded } = recordingChromeActs();
  const onCapture = vi.fn<PaneOverflowProps["onCapture"]>();
  render(
    <PaneOverflow
      acts={acts}
      pages={{ kind: "reading" }}
      canOpenDevtools
      roots={{ kind: "reading" }}
      refusal={undefined}
      sessionStore={undefined}
      producedCards={new Map()}
      toolCalls={{ kind: "reading" }}
      handback={handback}
      onCapture={onCapture}
    />,
  );
  return { recorded, onCapture };
}

/** The note inside one named region, rather than whichever note the document has first. */
function regionNote(head: string): string {
  const region = screen.getByRole("heading", { name: head }).closest(".meridian-browser-region");
  return region?.querySelector(".meridian-browser-region__note")?.textContent ?? "";
}

describe("the pane's overflow control", () => {
  it("stays closed until a person opens it", () => {
    renderOverflow();
    const disclosure = document.querySelector("details");
    expect(disclosure instanceof HTMLDetailsElement && disclosure.open).toBe(false);
    expect(screen.getByText("More")).toBeTruthy();
  });

  it("carries every region the pane does not keep in its chrome", () => {
    renderOverflow();
    const headings = [...document.querySelectorAll(".meridian-browser-region__head")].map(
      (head) => head.textContent,
    );
    expect(headings).toEqual([
      "Pages",
      "This page",
      "Local files",
      "Produced objects",
      "Agent tool calls",
      "Keyboard handback",
      "Site data",
    ]);
  });

  it("dispatches this page's acts, and captures through the pane that holds the answer", () => {
    const { recorded, onCapture } = renderOverflow();
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick element" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide page" }));
    expect(onCapture).toHaveBeenCalledOnce();
    expect(recorded).toEqual([
      { member: "pickElement", argument: undefined },
      { member: "hidePage", argument: undefined },
    ]);
  });

  it("names what clearing site data does before the control is armed", () => {
    renderOverflow();
    const sentence = regionNote("Site data");
    expect(sentence).toContain("cookies");
    expect(sentence).toContain("profile directory");
    expect(sentence).toContain("closed first");
  });

  it("clears site data through the act rather than deciding anything itself", () => {
    const { recorded } = renderOverflow();
    fireEvent.click(screen.getByRole("button", { name: "Clear site data" }));
    expect(recorded).toEqual([{ member: "clearSiteData", argument: undefined }]);
  });

  it("says a pane in no session has no produced objects to show, not that there are none", () => {
    renderOverflow();
    const badge = screen.getByText("No session behind this pane");
    expect(screen.queryByText("Nothing produced yet")).toBeNull();
    // The KIND carries the claim, so the class is what the case reads: `empty` would
    // say a session was looked at and held nothing, over a pane that has no session.
    expect(badge.closest(".meridian-nothing")?.className).toContain(
      "meridian-nothing--not-checked",
    );
  });

  it("reports the standing handback rather than routing it to the pane's banner", () => {
    renderOverflow();
    expect(regionNote("Keyboard handback")).toContain("2 chords");
    expect(regionNote("Keyboard handback")).toContain("3 replayed");
    expect(document.querySelector(".meridian-refusal--banner")).toBeNull();
  });

  it("renders a refused mirror inline, where the control it degrades is", () => {
    renderOverflow({
      mirrorChords: undefined,
      refusal: {
        origin: "browser-keyboard-handback",
        code: "chord-mirror-publish-failed",
        detail: "The console's chords could not be published to the page host.",
      },
      replayCount: 0,
    });
    const refusal = document.querySelector(".meridian-refusal--inline");
    expect(refusal?.textContent).toContain("chord-mirror-publish-failed");
    expect(document.querySelector(".meridian-refusal--banner")).toBeNull();
  });

  it("negative control: an unreadable chord table is not reported as a refusal", () => {
    // 12.4's degraded arm publishes nothing and refuses nothing, so a surface that
    // rendered a refusal here would be inventing one the binding never raised.
    renderOverflow({ mirrorChords: undefined, refusal: undefined, replayCount: 0 });
    expect(document.querySelector(".meridian-refusal")).toBeNull();
    expect(screen.getByText("No chord is claimed from the page")).toBeTruthy();
  });
});
