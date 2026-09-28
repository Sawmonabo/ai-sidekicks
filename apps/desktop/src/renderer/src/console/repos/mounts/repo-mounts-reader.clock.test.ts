// Which clock the section's reading is stamped on, and what a wall clock would say.
//
// THE READING CARRIES AN INSTANT AND THE CARDS SPEND IT. `readAtMilliseconds` is what
// every age on a mount card is measured against, so the clock the hook hands its reader
// decides what those figures SAY. `consoleClockFor` is the one answer to which clock a
// window runs on; a reader stamping off a `RealClock` of its own would put two time
// bases on one screen and make every age move with the day it was rendered.
//
// The negative control drives the shape that would be wrong, so the claim is about the
// clock and not about the dates in the rows.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock, REFRESH_DEBOUNCE_MS, RealClock } from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { SessionStore } from "../../store/index.js";
import { bridgeOnClock } from "../repo-operations.test-support.js";
import { useRepoMounts } from "./repo-mounts-binding.js";
import { RepoMountsReader } from "./repo-mounts-reader.js";
import {
  SESSION_ID,
  disposeTrackedReaders,
  sessionOperations,
  trackReader,
} from "./repo-mounts.test-support.js";

// Every reader a case opens is tracked, and none of them outlives its case.
afterEach(disposeTrackedReaders);

/** How long the wall-clock control may take to spend a real debounce interval. */
const WALL_CLOCK_TIMEOUT_MS = 5_000;

/** A window instant far from the machine's, so a wall-clock stamp cannot pass for it. */
const WINDOW_START_MILLISECONDS = 1_000;

describe("useRepoMounts — the reading is stamped on the window's own clock", () => {
  it("stamps the reading with the window's instant and not the wall clock", async () => {
    const clock = new ManualClock(WINDOW_START_MILLISECONDS);
    const bridge = bridgeOnClock(clock);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const operations = sessionOperations();
    const { result } = renderHook(() => useRepoMounts(bridge, sessionStore, operations));

    await crossMacrotaskBoundary();
    act(() => {
      clock.advance(REFRESH_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(result.current.reading.status).toBe("read");
    });

    // Equality with the window's clock, read back off it rather than spelled here.
    expect(result.current.reading.readAtMilliseconds).toBe(clock.now());
  });

  it("negative control: on a wall clock the same read lands years away", async () => {
    // The shape a reader with its own clock would have: the machine's.
    const reader = new RepoMountsReader({
      operations: sessionOperations(),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock: new RealClock(),
    });
    trackReader(reader);
    reader.start();
    // Spent in real time rather than driven, because a real clock is what this control
    // is about. `waitFor` is the one thing here that polls the machine.
    await waitFor(
      () => {
        expect(reader.snapshot.status).toBe("read");
      },
      { timeout: WALL_CLOCK_TIMEOUT_MS },
    );

    const stamped = reader.snapshot.readAtMilliseconds;
    expect(stamped).not.toBe(WINDOW_START_MILLISECONDS + REFRESH_DEBOUNCE_MS);
    expect(Math.abs(stamped - Date.now())).toBeLessThan(WALL_CLOCK_TIMEOUT_MS);
  });
});
