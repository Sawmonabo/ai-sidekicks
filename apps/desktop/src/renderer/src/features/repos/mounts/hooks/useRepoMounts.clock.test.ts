// The section's reading is stamped on the window's own clock, not a wall clock. A reader with
// a `RealClock` of its own would put two time bases on one screen and make every age on a
// mount card move with the day it was rendered.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock, RealClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { useRepoMounts } from "./useRepoMounts.js";
import { RepoMountsReader } from "../repo-mounts-reader.js";
import {
  SESSION_ID,
  disposeTrackedReaders,
  sessionOperations,
  trackReader,
} from "../repo-mounts.test-support.js";

afterEach(disposeTrackedReaders);

const WALL_CLOCK_TIMEOUT_MS = 5_000;

/** A window instant far from the machine's, so a wall-clock stamp cannot pass for it. */
const WINDOW_START_MILLISECONDS = 1_000;

describe("useRepoMounts — the reading is stamped on the window's own clock", () => {
  it("stamps the reading with the window's instant and not the wall clock", async () => {
    const clock = new ManualClock(WINDOW_START_MILLISECONDS);
    const { bridge } = bridgeOnClock("repos", clock);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const operations = sessionOperations();
    const { result } = renderHook(() => useRepoMounts(bridge, sessionStore, operations), {
      wrapper: bridgeWrapper(bridge, clock),
    });

    await crossMacrotaskBoundary();
    act(() => {
      clock.advance(REFRESH_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(result.current.reading.status).toBe("read");
    });

    expect(result.current.reading.readAtMilliseconds).toBe(clock.now());
  });

  it("negative control: on a wall clock the same read lands years away", async () => {
    const reader = new RepoMountsReader({
      operations: sessionOperations(),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock: new RealClock(),
    });
    trackReader(reader);
    reader.start();
    // Spent in real time because a real clock is the subject; `waitFor` is the one poll here.
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
