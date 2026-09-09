import { beforeEach, describe, expect, test } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { PERF_METER_BOUNDS } from "../../../core/perf-meters/perf-meter-bounds.js";
import { devPerfMeters } from "../../../core/perf-meters/perf-meters.js";
import {
  LEDGER_FRAME_PHASES,
  LedgerFrameCoordinator,
  type LedgerFrameDiagnostic,
} from "./frame-coordinator.js";

const constructCoordinator = (): { clock: ManualClock; coordinator: LedgerFrameCoordinator } => {
  const clock = new ManualClock();
  return { clock, coordinator: new LedgerFrameCoordinator({ clock }) };
};

describe("LedgerFrameCoordinator", () => {
  beforeEach(() => {
    devPerfMeters?.reset();
  });

  test("records the cost of every frame it drains, and nothing for a frame it does not", () => {
    const { clock, coordinator } = constructCoordinator();
    expect(devPerfMeters, "this project is not compiling the fixture define").not.toBe(null);

    // Nothing scheduled: the clock's frame runs no drain, so there is nothing to
    // meter and a series that existed here would be measuring the scheduler.
    clock.runFrame();
    expect(devPerfMeters?.readings()).toStrictEqual([]);

    coordinator.scheduleScrollWrite(coordinator.claimTaskKey("scroll"), () => {});
    clock.runFrame();

    const reading = devPerfMeters?.readings().find((entry) => entry.kind === "frame-time") ?? null;
    expect(reading, "a drained frame recorded no frame-time sample").not.toBeNull();
    expect(reading?.recordedCount).toBe(1);
    expect(Number(reading?.latest)).toBeGreaterThanOrEqual(0);
  });

  test("keys its frame time by coordinator, so two feeds are two series", () => {
    // There is one coordinator per FEED, not per window (`coordinator-binding.ts`), so
    // two feeds open side by side are two coordinators. Under a shared module constant
    // both feeds' frames landed in one series, and the p95 an author reads was an
    // average over a feed blowing the budget and a feed sitting idle — with no second
    // series anywhere to notice it by.
    const clock = new ManualClock();
    const firstFeed = new LedgerFrameCoordinator({ clock });
    const secondFeed = new LedgerFrameCoordinator({ clock });

    firstFeed.scheduleScrollWrite(firstFeed.claimTaskKey("scroll"), () => {});
    secondFeed.scheduleScrollWrite(secondFeed.claimTaskKey("scroll"), () => {});
    clock.runFrame();

    const frameTimes =
      devPerfMeters?.readings().filter((entry) => entry.kind === "frame-time") ?? [];
    expect(frameTimes).toHaveLength(2);
    expect(new Set(frameTimes.map((entry) => entry.seriesKey)).size).toBe(2);
    expect(firstFeed.coordinatorId).not.toBe(secondFeed.coordinatorId);
  });

  test("a mount-and-unmount cycle costs no lasting series, however many times it runs", () => {
    // The identity that makes two open feeds two series is minted from an ordinal that
    // never resets, so it names a MOUNT and not a live feed. Without a retirement the
    // key set grows with every feed this renderer has ever opened: past the registry's
    // series bound every further feed is refused, and the p95 an author reads is the
    // p95 of feeds that closed while the feed on screen contributes nothing to it.
    //
    // The count is the endurance workload's own: `console-workload.ts` alternates the
    // settings route and the session workspace, the workspace mounts the ledger, and
    // `steady-state.test.ts` drives 200 churn cycles twice.
    const mountCycleCount = 400;
    expect(
      mountCycleCount,
      "this case is vacuous unless it mounts past the registry's series bound",
    ).toBeGreaterThan(PERF_METER_BOUNDS.seriesCount);

    for (let cycle = 0; cycle < mountCycleCount; cycle += 1) {
      const clock = new ManualClock();
      const coordinator = new LedgerFrameCoordinator({ clock });
      coordinator.scheduleScrollWrite(coordinator.claimTaskKey("scroll"), () => {});
      clock.runFrame();
      coordinator.dispose();
    }

    expect(devPerfMeters?.refusedSeriesCount).toBe(0);
    expect(devPerfMeters?.seriesCount).toBe(0);
  });

  test("holds one live series per live coordinator, and drops it on dispose", () => {
    // The other half of the bound: retiring must not retire a SIBLING's series, which
    // a coordinator keying by anything the two share would do.
    const clock = new ManualClock();
    const firstFeed = new LedgerFrameCoordinator({ clock });
    const secondFeed = new LedgerFrameCoordinator({ clock });
    firstFeed.scheduleScrollWrite(firstFeed.claimTaskKey("scroll"), () => {});
    secondFeed.scheduleScrollWrite(secondFeed.claimTaskKey("scroll"), () => {});
    clock.runFrame();
    expect(devPerfMeters?.seriesCount).toBe(2);

    firstFeed.dispose();

    expect(devPerfMeters?.seriesCount).toBe(1);
    expect(devPerfMeters?.reading("frame-time", firstFeed.coordinatorId)).toBeNull();
    expect(devPerfMeters?.reading("frame-time", secondFeed.coordinatorId)).not.toBeNull();
  });

  test("runs scroll writes before reveal work, whatever order they were submitted in", () => {
    const { clock, coordinator } = constructCoordinator();
    const order: string[] = [];

    // Submitted the wrong way round on purpose: this is the arrival order the old
    // per-subsystem arming would have painted in.
    coordinator.scheduleRevealWork(coordinator.claimTaskKey("reveal"), () => {
      order.push("reveal");
    });
    coordinator.scheduleScrollWrite(coordinator.claimTaskKey("scroll"), () => {
      order.push("scroll");
    });

    clock.runFrame();

    expect(order).toEqual(["scroll", "reveal"]);
  });

  test("the phase order is the declared enumeration", () => {
    expect(LEDGER_FRAME_PHASES).toEqual(["scroll-writes", "reveal-work"]);
  });

  test("coalesces by task key, so repeated submissions cost one run", () => {
    const { clock, coordinator } = constructCoordinator();
    const taskKey = coordinator.claimTaskKey("reveal");
    let runCount = 0;

    for (let submission = 0; submission < 10; submission += 1) {
      coordinator.scheduleRevealWork(taskKey, () => {
        runCount += 1;
      });
    }

    expect(coordinator.pendingTaskCount).toBe(1);
    clock.runFrame();
    expect(runCount).toBe(1);
  });

  test("claimTaskKey hands two holders keys that do not collide", () => {
    const { clock, coordinator } = constructCoordinator();
    const runs: string[] = [];

    coordinator.scheduleRevealWork(coordinator.claimTaskKey("reveal-engine"), () => {
      runs.push("first");
    });
    coordinator.scheduleRevealWork(coordinator.claimTaskKey("reveal-engine"), () => {
      runs.push("second");
    });

    clock.runFrame();

    expect(runs).toEqual(["first", "second"]);
  });

  test("work a phase-one task submits for phase two joins the same frame", () => {
    const { clock, coordinator } = constructCoordinator();
    const order: string[] = [];

    coordinator.scheduleScrollWrite(coordinator.claimTaskKey("scroll"), () => {
      order.push("scroll");
      coordinator.scheduleRevealWork(coordinator.claimTaskKey("reveal"), () => {
        order.push("reveal");
      });
    });

    clock.runFrame();

    expect(order).toEqual(["scroll", "reveal"]);
  });

  test("a scroll write submitted from phase two is held for the next frame", () => {
    const { clock, coordinator } = constructCoordinator();
    const order: string[] = [];

    coordinator.scheduleRevealWork(coordinator.claimTaskKey("reveal"), () => {
      order.push("reveal");
      coordinator.scheduleScrollWrite(coordinator.claimTaskKey("scroll"), () => {
        order.push("scroll");
      });
    });

    clock.runFrame();
    // The negative control for the ordering rule: draining the deferred write inside
    // this frame would put `scroll` after `reveal`, which is the inversion the whole
    // coordinator exists to prevent.
    expect(order).toEqual(["reveal"]);
    expect(coordinator.pendingTaskCount).toBe(1);

    clock.runFrame();
    expect(order).toEqual(["reveal", "scroll"]);
  });

  test("a phase re-armed from inside its own drain runs on the next frame, not this one", () => {
    const { clock, coordinator } = constructCoordinator();
    let runCount = 0;
    const taskKey = coordinator.claimTaskKey("reveal");

    const submitDrain = (): void => {
      coordinator.scheduleRevealWork(taskKey, () => {
        runCount += 1;
        if (runCount < 3) {
          submitDrain();
        }
      });
    };
    submitDrain();

    clock.runFrame();
    expect(runCount).toBe(1);
    clock.runFrame();
    expect(runCount).toBe(2);
    clock.runFrame();
    expect(runCount).toBe(3);
    expect(coordinator.pendingTaskCount).toBe(0);
  });

  test("arms exactly one frame no matter how many tasks are pending", () => {
    const { clock, coordinator } = constructCoordinator();

    coordinator.scheduleScrollWrite(coordinator.claimTaskKey("scroll"), () => {});
    coordinator.scheduleRevealWork(coordinator.claimTaskKey("reveal"), () => {});

    expect(clock.pendingFrameCount).toBe(1);
    expect(coordinator.isFrameArmed).toBe(true);
  });

  test("a settled coordinator holds no armed frame", () => {
    const { clock, coordinator } = constructCoordinator();

    coordinator.scheduleRevealWork(coordinator.claimTaskKey("reveal"), () => {});
    clock.runFrame();

    expect(clock.pendingCount).toBe(0);
    expect(coordinator.isFrameArmed).toBe(false);
    expect(coordinator.pendingTaskCount).toBe(0);
  });

  test("quarantines a throwing task, finishes the phase, and reports it", () => {
    const { clock, coordinator } = constructCoordinator();
    const diagnostics: LedgerFrameDiagnostic[] = [];
    coordinator.subscribeToDiagnostics((diagnostic) => {
      diagnostics.push(diagnostic);
    });
    const throwingKey = coordinator.claimTaskKey("throwing");
    let survivorRan = false;

    coordinator.scheduleRevealWork(throwingKey, () => {
      throw new Error("lane transition failed");
    });
    coordinator.scheduleRevealWork(coordinator.claimTaskKey("survivor"), () => {
      survivorRan = true;
    });

    expect(() => {
      clock.runFrame();
    }).not.toThrow();
    expect(survivorRan).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.phase).toBe("reveal-work");
    expect(diagnostics[0]?.taskKey).toBe(throwingKey);
    expect(diagnostics[0]?.detail).toContain("lane transition failed");
  });

  test("a task throwing a null-prototype value still reports rather than escaping", () => {
    const { clock, coordinator } = constructCoordinator();
    const diagnostics: LedgerFrameDiagnostic[] = [];
    coordinator.subscribeToDiagnostics((diagnostic) => {
      diagnostics.push(diagnostic);
    });

    coordinator.scheduleScrollWrite(coordinator.claimTaskKey("scroll"), () => {
      throw Object.create(null) as unknown;
    });

    expect(() => {
      clock.runFrame();
    }).not.toThrow();
    expect(diagnostics).toHaveLength(1);
  });

  test("cancel drops a submitted task", () => {
    const { clock, coordinator } = constructCoordinator();
    const taskKey = coordinator.claimTaskKey("reveal");
    let ran = false;

    coordinator.scheduleRevealWork(taskKey, () => {
      ran = true;
    });
    coordinator.cancel("reveal-work", taskKey);
    clock.runFrame();

    expect(ran).toBe(false);
    // The budget claim moved here with the scheduler: cancelling the last task
    // releases the frame, so a settled console holds no timer at all.
    expect(clock.pendingCount).toBe(0);
    // Idempotent: a second cancel of a key that never ran is a no-op.
    expect(() => {
      coordinator.cancel("reveal-work", taskKey);
    }).not.toThrow();
  });

  test("a disposed coordinator accepts nothing and leaves no timer armed", () => {
    const { clock, coordinator } = constructCoordinator();
    let ran = false;

    coordinator.scheduleRevealWork(coordinator.claimTaskKey("reveal"), () => {
      ran = true;
    });
    coordinator.dispose();

    expect(clock.pendingCount).toBe(0);
    expect(coordinator.isDisposed).toBe(true);

    coordinator.scheduleScrollWrite(coordinator.claimTaskKey("scroll"), () => {
      ran = true;
    });
    expect(coordinator.pendingTaskCount).toBe(0);
    clock.runFrame();
    expect(ran).toBe(false);
  });
});
