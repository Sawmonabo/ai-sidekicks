// Where the pinned region sits in the frame, and what a frame draws when nothing fills
// it.
//
// Its own file rather than a fifth suite in `ConsolePaneChrome.test.tsx`, on the seam
// that file's own header names: that suite is about the frame's tables, its name, its
// controls and its key claim, and this is about the one region the frame draws for a
// family that does not own the pane. The claim that carries it is ORDER — head, then
// pinned, then body — because a region drawn inside the body would scroll away with the
// conversation, which is the one property a pinned region exists to have.
//
// Every case composes into a board the case owns. The chrome defaults to the
// process-wide board, and a suite that registered into that one would leave a claim
// standing for every other suite in the project.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConsolePaneChrome } from "./ConsolePaneChrome.js";
import { PaneControlsContext, type PaneControls } from "./pane-controls.js";
import { PinnedPaneRegionRegistry } from "./pinned-pane-regions.js";

/** A chrome with a body, over whichever board the case composed. */
function renderChrome(
  pinnedRegions: PinnedPaneRegionRegistry,
  scope: {
    readonly channelId?: string | undefined;
    /** The deck's acts, where the case is about one reaching the region. */
    readonly hostControls?: PaneControls;
  } = {},
): HTMLElement {
  const chrome = (
    <ConsolePaneChrome
      kind="timeline"
      sessionId="session-1"
      channelId={scope.channelId}
      focusHue={undefined}
      pinnedRegions={pinnedRegions}
    >
      <p>the timeline body</p>
    </ConsolePaneChrome>
  );
  const { container } = render(
    scope.hostControls === undefined ? (
      chrome
    ) : (
      <PaneControlsContext.Provider value={scope.hostControls}>
        {chrome}
      </PaneControlsContext.Provider>
    ),
  );
  return container;
}

/** The pane's own children, as element class names in document order. */
function paneRegions(container: HTMLElement): readonly string[] {
  const pane = container.querySelector(".meridian-pane");
  return [...(pane?.children ?? [])].map((child) => child.className);
}

describe("ConsolePaneChrome — the pinned region's place in the frame", () => {
  it("draws head, then the pinned region, then the body", () => {
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", { owner: "planted", render: () => <p>pinned progress</p> });

    const container = renderChrome(board);

    // The whole claim in one assertion: order AND membership, so a region appended
    // after the body — which renders identically to a reader of text alone — fails.
    expect(paneRegions(container)).toStrictEqual([
      "meridian-pane__head",
      "meridian-pane__pinned",
      "meridian-pane__body",
    ]);
    expect(container.querySelector(".meridian-pane__pinned")?.textContent).toBe("pinned progress");
    expect(container.querySelector(".meridian-pane__body")?.textContent).toBe("the timeline body");
  });

  it("draws no element at all for a kind nobody claimed", () => {
    // Not an empty box: the region carries its own padding and a hairline, so an
    // element drawn for an unfilled region is a visible gap under every pane in the
    // deck.
    const container = renderChrome(new PinnedPaneRegionRegistry());

    expect(paneRegions(container)).toStrictEqual(["meridian-pane__head", "meridian-pane__body"]);
  });

  it("draws no element for a body that had nothing to say about this pane", () => {
    // The card's own shape: keyed on a channel, so a session-scoped pane of the same
    // kind gets nothing. The negative control for the case above — without it, that
    // one is equally satisfied by a chrome that never draws the region at all.
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", {
      owner: "planted",
      render: (context) => (context.channelId === undefined ? null : <p>pinned progress</p>),
    });

    expect(paneRegions(renderChrome(board))).toStrictEqual([
      "meridian-pane__head",
      "meridian-pane__body",
    ]);
    expect(paneRegions(renderChrome(board, { channelId: "channel-1" }))).toStrictEqual([
      "meridian-pane__head",
      "meridian-pane__pinned",
      "meridian-pane__body",
    ]);
  });

  it("hands the region the host's opener, so a route lands in this pane's deck", () => {
    const openPane = vi.fn();
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", {
      owner: "planted",
      render: (context) => (
        <button type="button" onClick={() => context.openPane?.({ kind: "runs" })}>
          route
        </button>
      ),
    });

    const container = renderChrome(board, { hostControls: { openPane } });
    container.querySelector("button")?.click();

    expect(openPane).toHaveBeenCalledWith({ kind: "runs" });
  });

  it("negative control: hands the region nothing where the host offers no opener", () => {
    // Without this the case above would pass over a chrome that minted an opener of
    // its own — which would open a route in whichever deck was composed last, and in
    // an auxiliary window would open one in a deck that is not on screen.
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", {
      owner: "planted",
      render: (context) => <p>{context.openPane === undefined ? "no opener" : "an opener"}</p>,
    });

    expect(renderChrome(board).textContent).toContain("no opener");
  });

  it("hands the region the pane's own channel, so a claim is not global to the kind", () => {
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", {
      owner: "planted",
      render: (context) => <p>{context.channelId ?? "no channel"}</p>,
    });

    expect(renderChrome(board, { channelId: "channel-7" }).textContent).toContain("channel-7");
  });
});
