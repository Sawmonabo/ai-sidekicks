// The feed's four seams, asserted where a screenshot cannot reach them.
//
// WHAT THIS FILE IS FOR. `LedgerFeed.tsx` adds arrangement and the callbacks that
// let one piece act on another, and every one of those is a claim that fails
// silently: a rail thumb sized off a virtualizer with no element under it looks
// exactly like a correct one, a replay that moves a timestamp without moving the
// rows looks exactly like a replay, and a control offering an act nobody can
// perform looks exactly like a control. So the cases below drive the composed feed
// with a REAL store, a real projection, a real viewport binding, and the real
// structure models, and assert the seams rather than the pieces.
//
// `happy-dom` answers zero for every geometry read, which is why every case that
// needs the virtualizer to have a range stubs the two reads the chokepoint makes —
// `LedgerViewport.test.tsx`' stub, for its reason.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../bridge/scenarios/ledger-quiet.js";
import { SessionStore } from "../../store/index.js";
import { ParticipantHueAllocator } from "../../tokens/index.js";
import { type TimelineRowSlotProps } from "../../workspace/index.js";
import { LedgerFeed } from "./LedgerFeed.js";

const SESSION_ID = "session-ledger-feed";
const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;
const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;
const LONG_LOG_EVENT_COUNT = 300;

/**
 * Give the ledger a laid-out, scrollable box for the length of one case.
 *
 * Both reads are load-bearing and neither is the module under test: the
 * virtualizer treats a zero outer size as "no range at all", and the scroll
 * chokepoint clamps every write to `scrollHeight - clientHeight`.
 */
function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    LAID_OUT_VIEWPORT_HEIGHT_PX,
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    LAID_OUT_CONTENT_HEIGHT_PX,
  );
}

/** A real store holding a log of `count` run events, oldest first. */
function openSessionStoreWithLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      sessionId: SESSION_ID,
      sequence: index,
      kind: "run.running",
      occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString(),
      payload: { sessionId: SESSION_ID, runId: "019b793b-7b60-740e-8110-d1a4c1150111" },
    })),
  );
  return sessionStore;
}

/**
 * Mount the feed under a bridge, because the ledger reads the console clock.
 *
 * `onRowMounted` is how a case reads the three decisions the list makes for a row:
 * they reach the seat as arguments and never as markup, so a case that only read
 * the DOM could not see any of them.
 */
function renderFeed(
  sessionStore: SessionStore,
  onRowMounted?: (mount: TimelineRowSlotProps) => void,
): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO })}>
      <LedgerFeed
        sessionStore={sessionStore}
        renderTimelineRow={(mount) => {
          onRowMounted?.(mount);
          return <p>{mount.row.summary}</p>;
        }}
        feedLabel="Session timeline"
      />
    </SidekicksBridgeProvider>,
  );
  const feed = container.querySelector(".meridian-ledger");
  if (!(feed instanceof HTMLElement)) {
    throw new Error("LedgerFeed rendered no ledger element");
  }
  return feed;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ledger feed — one binding", () => {
  it("sizes the rail from the virtualizer that holds the mounted surface", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(LONG_LOG_EVENT_COUNT));
    const thumb = feed.querySelector<HTMLElement>(".meridian-rail__thumb");
    expect(thumb).not.toBeNull();
    // A rendered range is a range: the thumb covers the fraction of the log that is
    // on screen. While the rail read a SECOND binding — one that was handed no
    // element — that binding's virtualizer had no range at all, so the extent fell
    // back to the whole rail and the thumb claimed the reader could see everything.
    expect(thumb?.style.height).not.toBe("100%");
    expect(Number.parseFloat(thumb?.style.height ?? "100")).toBeLessThan(50);
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

/**
 * Two participants whose PREFERRED wheel step is the same, so which of them takes
 * it is decided by admission order and by nothing else.
 *
 * The collision is the instrument: with distinct preferred steps both orders agree
 * and the case below would pass over either allocator.
 */
const EARLY_JOINER = "participant-alba";
const LATE_JOINER = "participant-enzo";

/** A store whose join order and first-event order deliberately disagree. */
function openStoreWhereJoinOrderIsNotEventOrder(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({
    cursor: -1,
    entities: [],
    participantJoinLog: [EARLY_JOINER, LATE_JOINER],
  });
  sessionStore.applyBatch([
    {
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "user.message",
      occurredAt: "2026-01-01T11:00:00.000Z",
      actorParticipantId: LATE_JOINER,
      payload: {},
    },
    {
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "user.message",
      occurredAt: "2026-01-01T11:00:01.000Z",
      actorParticipantId: EARLY_JOINER,
      payload: {},
    },
  ]);
  return sessionStore;
}

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
