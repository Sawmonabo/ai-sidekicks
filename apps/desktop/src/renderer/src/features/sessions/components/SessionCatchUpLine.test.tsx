// The catching-up line: when it shows, what a press on `Try again` asks for, and where the
// cause goes. Every case drives a real store on a manual clock handed to the window, so a case
// moves time instead of waiting on it. The mounts case drives the real repo mounts reader, the
// one read the session screen depends on beside its own.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "#renderer/lib/reads/refresh/caps.js";
import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { OpenSessionEntry } from "#renderer/store/session/open/entry.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { failingRepoMountsReader } from "#test/helpers/failing-repo-mounts-reader.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { CATCH_UP_LINE_DWELL_MS } from "../hooks/useCatchUpLineWords.js";
import { type LiveAnnouncer } from "#renderer/components/LiveAnnouncer/announcer.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS } from "#renderer/components/LiveAnnouncer/caps.js";
import { drawnText, liveRegionText } from "#test/helpers/live-region.js";
import { spiedAnnouncer } from "#test/helpers/spied-announcer.js";
import { SessionCatchUpLine } from "./SessionCatchUpLine.js";
import { openingPageLimit, offScreenRowLimit } from "#test/helpers/session/store/fixtures.js";

const SESSION_ID = "session-catching-up";

let detachForwarder: (() => void) | undefined;

afterEach(() => {
  detachForwarder?.();
  detachForwarder = undefined;
});

function renderLine(
  sessionStore: SessionStore,
  clock: ManualClock,
  onTryAgain: (sessionId: string) => void = () => undefined,
  announcer?: LiveAnnouncer,
): HTMLElement {
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  return render(
    <PlatformBridgeProvider bridge={fixture.bridge} clock={clock}>
      <LiveAnnouncerProvider announcer={announcer} clock={clock}>
        <SessionCatchUpLine sessionStore={sessionStore} onTryAgain={onTryAgain} />
      </LiveAnnouncerProvider>
    </PlatformBridgeProvider>,
  ).container;
}

function advance(clock: ManualClock, milliseconds: number): void {
  act(() => {
    clock.advance(milliseconds);
  });
}

describe("SessionCatchUpLine", () => {
  it("says it couldn't catch up each time the repair read of a gap fails", async () => {
    const clock = new ManualClock(0);
    let readRejects = false;
    // Its own session, so the capture case below reads only its own records.
    const entry = new OpenSessionEntry("session-gap-repair", {
      openingPageLimit,
      offScreenRowLimit,
      read: () =>
        readRejects
          ? Promise.reject(new Error("the daemon refused the read"))
          : Promise.resolve({ cursor: 0, entities: [] }),
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });
    const container = renderLine(entry.store, clock);
    async function readOnce(): Promise<void> {
      await act(async () => {
        entry.refreshScheduler.request("subscribe");
        clock.advance(21);
        for (let turn = 0; turn < 4; turn += 1) {
          await Promise.resolve();
        }
      });
    }

    await readOnce();
    act(() => {
      entry.store.markDegraded("sequence-gap");
    });
    readRejects = true;
    await readOnce();
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    const afterTheRepairFailed = drawnText(container);
    const saidOnTheFirstFailure = liveRegionText(container, "assertive");
    advance(clock, LIVE_ANNOUNCEMENT_HOLD_MS);
    // A second failure leaves the same words standing; it is a new failure all the same.
    await readOnce();
    const saidOnTheSecondFailure = liveRegionText(container, "assertive");
    readRejects = false;
    await readOnce();
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    entry.dispose();

    expect(afterTheRepairFailed).toBe("Couldn't catch up · Try again");
    expect([saidOnTheFirstFailure, saidOnTheSecondFailure]).toStrictEqual([
      "Couldn't catch up",
      "Couldn't catch up",
    ]);
    expect(drawnText(container)).toBe("");
  });

  it("says it couldn't catch up each time a replay fails on the same row", async () => {
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry("session-failing-row", {
      openingPageLimit,
      offScreenRowLimit,
      read: () => Promise.resolve({ entities: [] }),
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
      projectors: {
        "run.starting": (event) => {
          if (event.sequence === 7) {
            throw new TypeError("the payload was not the shape this projector claims");
          }
          return [];
        },
      },
    });
    const spied = spiedAnnouncer(clock);
    const container = renderLine(
      entry.store,
      clock,
      () => {
        entry.refreshScheduler.request("user-request");
      },
      spied.announcer,
    );
    async function landRead(): Promise<void> {
      await act(async () => {
        clock.advance(21);
        for (let turn = 0; turn < 4; turn += 1) {
          await Promise.resolve();
        }
      });
    }
    function deliver(sequences: readonly number[]): void {
      act(() => {
        entry.applyQueue.enqueueAll(
          sequences.map((sequence) => eventOfKind(entry.store.sessionId, "run.starting", sequence)),
        );
        entry.applyQueue.flush();
      });
    }
    function pressTryAgain(): void {
      const tryAgain = container.querySelector("button");
      if (tryAgain === null) {
        throw new Error("the failed line drew no Try again");
      }
      fireEvent.click(tryAgain);
    }

    entry.refreshScheduler.request("subscribe");
    await landRead();
    deliver([6, 7]);
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    const afterTheRowFailed = drawnText(container);
    // A replay failing on the same row inside the hold leaves the words where they stood.
    pressTryAgain();
    await landRead();
    deliver([6, 7]);
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    // One that runs past the hold is catching up while it runs.
    pressTryAgain();
    await landRead();
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    const whileTheReplayRuns = drawnText(container);
    deliver([6, 7]);
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    entry.dispose();

    expect(afterTheRowFailed).toBe("Couldn't catch up · Try again");
    expect(whileTheReplayRuns).toBe("Catching up…");
    // No read is coming for the row, so the line stands with Try again.
    expect(drawnText(container)).toBe("Couldn't catch up · Try again");
    // Each failure is said, the one that never moved the words included.
    expect(spied.spokenOn("assertive")).toStrictEqual([
      "Couldn't catch up",
      "Couldn't catch up",
      "Couldn't catch up",
    ]);
  });

  it("says it couldn't catch up if the mounts read fails after a good session read", async () => {
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry("session-mounts-failed", {
      openingPageLimit,
      offScreenRowLimit,
      read: () => Promise.resolve({ cursor: 0, entities: [] }),
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });
    const mountsReader = failingRepoMountsReader(entry.store, clock);
    const container = renderLine(entry.store, clock, () => {
      entry.refreshScheduler.request("user-request");
    });
    async function landReads(): Promise<void> {
      await act(async () => {
        clock.advance(REFRESH_DEBOUNCE_MS);
        for (let turn = 0; turn < 10; turn += 1) {
          await Promise.resolve();
        }
      });
    }

    entry.refreshScheduler.request("subscribe");
    mountsReader.start();
    await landReads();
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    const afterTheMountsReadFailed = drawnText(container);
    entry.refreshScheduler.request("user-request");
    await landReads();
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    const afterAGoodSessionRead = drawnText(container);
    const tryAgain = container.querySelector("button");
    if (tryAgain === null) {
      throw new Error("the failed line drew no Try again");
    }
    fireEvent.click(tryAgain);
    await landReads();
    const mountsReads = mountsReader.performCount;
    mountsReader.dispose();
    entry.dispose();

    expect(entry.refreshScheduler.performCount).toBe(3);
    expect(afterTheMountsReadFailed).toBe("Couldn't catch up · Try again");
    expect(afterAGoodSessionRead).toBe("Couldn't catch up · Try again");
    expect(mountsReads).toBe(2);
  });

  it("says nothing more when a session read lands beside a dependent read still failed", async () => {
    const clock = new ManualClock(0);
    let readRejects = true;
    const entry = new OpenSessionEntry("session-read-lands", {
      openingPageLimit,
      offScreenRowLimit,
      read: () =>
        readRejects
          ? Promise.reject(new Error("the daemon refused the read"))
          : Promise.resolve({ cursor: 0, entities: [] }),
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });
    const mountsReader = failingRepoMountsReader(entry.store, clock);
    const container = renderLine(entry.store, clock);
    async function landReads(): Promise<void> {
      await act(async () => {
        clock.advance(REFRESH_DEBOUNCE_MS);
        for (let turn = 0; turn < 10; turn += 1) {
          await Promise.resolve();
        }
      });
    }

    entry.refreshScheduler.request("subscribe");
    mountsReader.start();
    await landReads();
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    const saidOnTheFailures = liveRegionText(container, "assertive");
    advance(clock, LIVE_ANNOUNCEMENT_HOLD_MS);
    readRejects = false;
    entry.refreshScheduler.request("user-request");
    await landReads();
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    const afterTheSessionReadLanded = drawnText(container);
    const saidOnTheLanding = liveRegionText(container, "assertive");
    mountsReader.dispose();
    entry.dispose();

    expect(saidOnTheFailures).toBe("Couldn't catch up");
    expect(afterTheSessionReadLanded).toBe("Couldn't catch up · Try again");
    expect(saidOnTheLanding).toBe("");
  });

  it("asks for exactly one re-read of this session when Try again is pressed", () => {
    const clock = new ManualClock(0);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.markReadFailed();
    const rereads: string[] = [];
    const container = renderLine(sessionStore, clock, (sessionId) => {
      rereads.push(sessionId);
    });
    advance(clock, CATCH_UP_LINE_DWELL_MS);

    const tryAgain = container.querySelector("button");
    if (tryAgain === null) {
      throw new Error("the failed line drew no Try again");
    }
    fireEvent.click(tryAgain);

    expect(rereads).toStrictEqual([SESSION_ID]);
  });

  it("sends the cause to the diagnostic capture and never to the screen", async () => {
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry(SESSION_ID, {
      openingPageLimit,
      offScreenRowLimit,
      read: () => Promise.reject(new Error("the daemon refused the read")),
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });
    const batches: string[] = [];
    detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    const container = renderLine(entry.store, clock);

    await act(async () => {
      entry.refreshScheduler.request("subscribe");
      clock.advance(21);
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
    });
    advance(clock, CATCH_UP_LINE_DWELL_MS);
    windowDiagnosticCapture.flush();
    entry.dispose();

    const records = batches
      .flatMap((batch) => batch.split("\n"))
      .map((line) => JSON.parse(line) as { severity: string; detail: string })
      .filter((record) => record.detail.includes(SESSION_ID));
    expect(records).toStrictEqual([
      expect.objectContaining({
        severity: "warning",
        detail: `session ${SESSION_ID}: read-failed`,
      }),
    ]);
    expect(drawnText(container)).toBe("Couldn't catch up · Try again");
    expect(liveRegionText(container, "assertive")).toBe("Couldn't catch up");
    expect(container.textContent).not.toContain("read-failed");
  });
});
