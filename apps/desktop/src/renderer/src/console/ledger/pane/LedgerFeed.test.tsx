// The rail seam: what the feed tells the rail about where the reader is.
//
// WHAT THIS FILE IS FOR. `LedgerFeed.tsx` adds arrangement and the callbacks that
// let one piece act on another, and every one of those is a claim that fails
// silently — a rail thumb sized off a virtualizer with no element under it looks
// exactly like a correct one. So the cases below drive the composed feed with a
// REAL store, a real projection, a real viewport binding, and the real rail model,
// and assert the seam rather than the pieces.
//
// The feed's other three subjects are their own files, on this package's ~400-line
// rule: `LedgerFeedAbsences.test.tsx`, `LedgerFeedReplay.test.tsx`, and
// `LedgerFeedSeats.test.tsx`. The scaffolding they share is `LedgerFeedFixtures.test-support.tsx`.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { projectFixtureShellRows } from "../cards/index.js";
import { LEDGER_OVERSCAN_ROWS } from "../frame/frame-bounds.js";
import { ProvenanceRail, ProvenanceRailModel } from "../structure/index.js";
import { ParticipantHueAllocator } from "../../tokens/index.js";
import {
  LONG_LOG_EVENT_COUNT,
  OVER_CAP_EVENT_COUNT,
  recordRailInk,
  renderFeed,
  withLaidOutViewport,
} from "./LedgerFeedFixtures.test-support.js";
import {
  EARLY_JOINER,
  LATE_JOINER,
  openSessionStoreWithGeneralLog,
  openSessionStoreWithLog,
  openStoreWhereJoinOrderIsNotEventOrder,
} from "./ledger-feed-logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ledger feed — one binding", () => {
  it("sizes the rail from the rows the box intersects, not the rows it mounts", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(LONG_LOG_EVENT_COUNT));
    const thumb = feed.querySelector<HTMLElement>(".meridian-rail__thumb");
    expect(thumb).not.toBeNull();
    // Both readings come off the DOM, so this discriminates rather than restating a
    // constant. At the head there is no leading overscan, so the mounted rows are
    // the intersected ones plus one trailing overscan band; `aria-setsize` carries
    // the window's whole length. "Under 50%" passed at BOTH readings.
    const mountedRows = [...feed.querySelectorAll(".meridian-ledger-viewport__row")];
    const windowRowCount = Number(mountedRows[0]?.getAttribute("aria-setsize"));
    const intersectedRowCount = mountedRows.length - LEDGER_OVERSCAN_ROWS;
    expect(intersectedRowCount).toBeGreaterThan(0);
    const thumbHeightPercent = Number.parseFloat(thumb?.style.height ?? "100");
    expect(thumbHeightPercent).toBeCloseTo((intersectedRowCount / windowRowCount) * 100, 4);
    // And the reading the mount range would have produced is a different number,
    // which is what makes the assertion above a claim about the overscan.
    expect(thumbHeightPercent).toBeLessThan((mountedRows.length / windowRowCount) * 100);
  });

  it("negative control: with no laid-out box there is no range, and the rail says so", () => {
    // Without this the case above would pass over any thumb style at all. An
    // unmeasured viewport genuinely has no rendered range, and the honest rail for
    // one is the full-height thumb — which is exactly what a rail reading an
    // unattached binding drew on a fully laid-out ledger.
    const feed = renderFeed(openSessionStoreWithLog(LONG_LOG_EVENT_COUNT));
    const thumb = feed.querySelector<HTMLElement>(".meridian-rail__thumb");
    expect(thumb?.style.height).toBe("100%");
  });
});

describe("the ledger feed — one wheel", () => {
  it("hands each row the hue the session store allocated", () => {
    withLaidOutViewport();
    const sessionStore = openStoreWhereJoinOrderIsNotEventOrder();
    const stepByActor = new Map<string, number>();
    renderFeed(sessionStore, (mount) => {
      if (mount.row.actor !== undefined && mount.participantHue !== undefined) {
        stepByActor.set(mount.row.actor, mount.participantHue.step);
      }
    });
    expect(stepByActor.get(EARLY_JOINER)).toBe(
      sessionStore.hueAllocator.assignmentFor(EARLY_JOINER)?.step,
    );
    expect(stepByActor.get(LATE_JOINER)).toBe(
      sessionStore.hueAllocator.assignmentFor(LATE_JOINER)?.step,
    );
  });

  it("negative control: allocating over first-event order gives the other answer", () => {
    // Without this the case above would pass over a ledger that kept its own wheel,
    // because two allocators agree wherever the two orders do. These two ids prefer
    // the same step, so the order decides who gets it — and the orders disagree.
    const byFirstEvent = new ParticipantHueAllocator();
    byFirstEvent.admit(LATE_JOINER);
    byFirstEvent.admit(EARLY_JOINER);
    const sessionStore = openStoreWhereJoinOrderIsNotEventOrder();
    expect(byFirstEvent.assignmentFor(EARLY_JOINER)?.step).not.toBe(
      sessionStore.hueAllocator.assignmentFor(EARLY_JOINER)?.step,
    );
  });
});

describe("the ledger feed — the rail wears the session's own hues", () => {
  it("paints each actor's marks in that actor's allocated hue", () => {
    withLaidOutViewport();
    const inkPerMark = recordRailInk();
    renderFeed(openStoreWhereJoinOrderIsNotEventOrder());
    // Two speakers, two hues. While the rail was handed no lookup at all, both
    // marks took the one neutral tone and the map said nothing about who acted.
    expect(new Set(inkPerMark).size).toBe(2);
  });

  it("negative control: a rail handed no allocation paints one neutral tone", () => {
    // The rail as this feed mounted it before this change, over the same two rows:
    // the marks are still drawn, and they are all the same colour.
    const inkPerMark = recordRailInk();
    const sessionStore = openStoreWhereJoinOrderIsNotEventOrder();
    const { rows } = projectFixtureShellRows(sessionStore.snapshot().timeline);
    render(
      <ProvenanceRail
        model={new ProvenanceRailModel({ rows, hasEarlierRows: false })}
        viewportPosition={0}
        viewportExtent={1}
        isFollowing={false}
        onJumpToRow={() => undefined}
      />,
    );
    expect(inkPerMark.length).toBeGreaterThan(1);
    expect(new Set(inkPerMark).size).toBe(1);
  });
});

describe("the ledger feed — the clip it draws is the clip that is true", () => {
  it("draws the unloaded segment once the cap has taken rows", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(OVER_CAP_EVENT_COUNT));
    expect(feed.querySelector(".meridian-rail__unloaded")).not.toBeNull();
    expect(feed.textContent).toContain("Older entries are no longer in this window.");
    // And still no control, because no registered read returns rows before the head.
    expect(feed.querySelector(".meridian-rail__load-earlier")).toBeNull();
    expect(feed.querySelector(".meridian-find__load-earlier")).toBeNull();
  });

  it("negative control: a whole log under the cap draws no segment", () => {
    // Without this the case above would pass over a clip hard-coded true, which
    // would mark every complete session as truncated.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(5));
    expect(feed.querySelector(".meridian-rail__unloaded")).toBeNull();
    expect(feed.textContent).not.toContain("Older entries are no longer in this window.");
  });
});
