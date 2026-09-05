// Which clock the section's reading is stamped on, and what a wall clock would say.
//
// THE READING CARRIES AN INSTANT AND THE CARDS SPEND IT. `readAtMilliseconds` is what
// every age on a mount card is measured against and what the clone list's disposal
// countdown is compared to, so the clock the hook hands its reader decides what those
// figures SAY. Under the fixture the answer has to be the scenario's frozen clock:
// `consoleClockFor` is the one answer to which clock a window runs on, and the clone
// list's own deadline wake-up already reads it — so a reader stamping off a `RealClock`
// of its own put two time bases in one list, and the wall clock won every `Math.max`.
//
// WHAT THAT COST, MEASURED RATHER THAN ASSERTED. The scenario's rows are dated
// 2026-01-01, so against a wall clock every age renders as a day count that moves every
// day — a committed screenshot reference stops matching within twenty-four hours of the
// run that minted it — and the clone whose disposal is scheduled 1.5 seconds into the
// scenario reads as `elapsed`, which is a different composition from the one the fixture
// was written to state. The negative control drives the shape the hook used to build,
// so both claims are about the clock rather than about the scenario's dates.

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { RealClock } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { advanceScenarioUntil } from "../scenario-clock.test-support.js";
import { RepoMountsReader, useRepoMounts } from "./repo-mounts-reader.js";
import { cloneExpiryReading, type EphemeralCloneStatusRecord } from "./worktree-model.js";

/** How long the wall-clock control may take to spend a real debounce interval. */
const WALL_CLOCK_TIMEOUT_MS = 5_000;

const readers: RepoMountsReader[] = [];

afterEach(() => {
  while (readers.length > 0) {
    readers.pop()?.dispose();
  }
});

/** The scenario's own frozen clock, which is what `consoleClockFor` answers with here. */
function scenarioNow(bridge: ConsoleBridge): number {
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge carries no scenario engine to read a clock off");
  }
  return engine.clock.now();
}

/** The scenario's clone that has not been swept, which is the one with a live deadline. */
function undisposedClone(
  clones: readonly EphemeralCloneStatusRecord[],
): EphemeralCloneStatusRecord {
  const scheduled = clones.find((clone) => clone.cleanedAt === undefined);
  if (scheduled === undefined) {
    throw new Error("the repos scenario names no clone still awaiting disposal");
  }
  return scheduled;
}

describe("useRepoMounts — the reading is stamped on the window's own clock", () => {
  it("stamps the reading with the scenario's frozen instant and not the wall clock", async () => {
    const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });
    const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
    const { result } = renderHook(() => useRepoMounts(bridge, sessionStore));

    await advanceScenarioUntil(bridge, () => {
      expect(result.current.reading.status).toBe("read");
    });

    // Equality with the FIXTURE's clock, read back off the bridge rather than spelled
    // here: a literal would pin this case to the scenario's start date and pass for
    // the wrong reason the day the fixture is re-dated.
    expect(result.current.reading.readAtMilliseconds).toBe(scenarioNow(bridge));
    // And the clone whose disposal the scenario schedules is still scheduled, which is
    // the composition that stamp produces on screen.
    expect(
      cloneExpiryReading(
        undisposedClone(result.current.reading.ephemeralClones),
        result.current.reading.readAtMilliseconds,
      ),
    ).toBe("scheduled");
  });

  it("negative control: on a wall clock the same read lands years away and reads elapsed", async () => {
    // The shape the hook used to build — a reader whose clock was the machine's. Both
    // assertions above are false against it.
    const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });
    const reader = new RepoMountsReader({
      bridge,
      sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
      clock: new RealClock(),
    });
    readers.push(reader);
    reader.start();
    // Spent in real time rather than driven, because a real clock is what this control
    // is about: the scenario engine's advance would move nothing this reader is waiting
    // on. `waitFor` is the one thing here that polls the machine.
    await waitFor(
      () => {
        expect(reader.snapshot.status).toBe("read");
      },
      { timeout: WALL_CLOCK_TIMEOUT_MS },
    );

    const reading = reader.snapshot;
    expect(reading.readAtMilliseconds).not.toBe(scenarioNow(bridge));
    expect(Math.abs(reading.readAtMilliseconds - Date.now())).toBeLessThan(WALL_CLOCK_TIMEOUT_MS);
    const scheduled = undisposedClone(reading.ephemeralClones);
    expect(cloneExpiryReading(scheduled, reading.readAtMilliseconds)).toBe("elapsed");
    expect(cloneExpiryReading(scheduled, scenarioNow(bridge))).toBe("scheduled");
  });
});
