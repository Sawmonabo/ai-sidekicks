import { beforeEach, describe, expect, test } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { developmentPerformanceMeters } from "@renderer/lib/performance-meters/performance-meters.js";
import {
  AnimationFrameScheduler,
  type AnimationFrameDiagnostic,
} from "./animation-frame-scheduler.js";

const constructScheduler = (): { clock: ManualClock; scheduler: AnimationFrameScheduler } => {
  const clock = new ManualClock();
  return { clock, scheduler: new AnimationFrameScheduler({ clock }) };
};

describe("AnimationFrameScheduler", () => {
  beforeEach(() => {
    developmentPerformanceMeters?.reset();
  });

  test("runs scroll writes before reveal work, whatever order they were submitted in", () => {
    const { clock, scheduler } = constructScheduler();
    const order: string[] = [];

    // Submitted in the wrong order on purpose.
    scheduler.scheduleRevealWork(scheduler.claimTaskKey("reveal"), () => {
      order.push("reveal");
    });
    scheduler.scheduleScrollWrite(scheduler.claimTaskKey("scroll"), () => {
      order.push("scroll");
    });

    clock.runFrame();

    expect(order).toEqual(["scroll", "reveal"]);
  });

  test("coalesces by task key, so repeated submissions cost one run", () => {
    const { clock, scheduler } = constructScheduler();
    const taskKey = scheduler.claimTaskKey("reveal");
    let runCount = 0;

    for (let submission = 0; submission < 10; submission += 1) {
      scheduler.scheduleRevealWork(taskKey, () => {
        runCount += 1;
      });
    }

    expect(scheduler.pendingTaskCount).toBe(1);
    clock.runFrame();
    expect(runCount).toBe(1);
  });

  test("claimTaskKey hands two holders keys that do not collide", () => {
    const { clock, scheduler } = constructScheduler();
    const runs: string[] = [];

    scheduler.scheduleRevealWork(scheduler.claimTaskKey("reveal-engine"), () => {
      runs.push("first");
    });
    scheduler.scheduleRevealWork(scheduler.claimTaskKey("reveal-engine"), () => {
      runs.push("second");
    });

    clock.runFrame();

    expect(runs).toEqual(["first", "second"]);
  });

  test("work a phase-one task submits for phase two joins the same frame", () => {
    const { clock, scheduler } = constructScheduler();
    const order: string[] = [];

    scheduler.scheduleScrollWrite(scheduler.claimTaskKey("scroll"), () => {
      order.push("scroll");
      scheduler.scheduleRevealWork(scheduler.claimTaskKey("reveal"), () => {
        order.push("reveal");
      });
    });

    clock.runFrame();

    expect(order).toEqual(["scroll", "reveal"]);
  });

  test("a scroll write submitted from phase two is held for the next frame", () => {
    const { clock, scheduler } = constructScheduler();
    const order: string[] = [];

    scheduler.scheduleRevealWork(scheduler.claimTaskKey("reveal"), () => {
      order.push("reveal");
      scheduler.scheduleScrollWrite(scheduler.claimTaskKey("scroll"), () => {
        order.push("scroll");
      });
    });

    clock.runFrame();
    // Negative control: draining the deferred write inside this frame would put `scroll`
    // after `reveal`.
    expect(order).toEqual(["reveal"]);
    expect(scheduler.pendingTaskCount).toBe(1);

    clock.runFrame();
    expect(order).toEqual(["reveal", "scroll"]);
  });

  test("a phase re-armed from inside its own drain runs on the next frame, not this one", () => {
    const { clock, scheduler } = constructScheduler();
    let runCount = 0;
    const taskKey = scheduler.claimTaskKey("reveal");

    const submitDrain = (): void => {
      scheduler.scheduleRevealWork(taskKey, () => {
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
    expect(scheduler.pendingTaskCount).toBe(0);
  });

  test("arms exactly one frame no matter how many tasks are pending", () => {
    const { clock, scheduler } = constructScheduler();

    scheduler.scheduleScrollWrite(scheduler.claimTaskKey("scroll"), () => {});
    scheduler.scheduleRevealWork(scheduler.claimTaskKey("reveal"), () => {});

    expect(clock.pendingFrameCount).toBe(1);
    expect(scheduler.isFrameArmed).toBe(true);
  });

  test("a settled scheduler holds no armed frame", () => {
    const { clock, scheduler } = constructScheduler();

    scheduler.scheduleRevealWork(scheduler.claimTaskKey("reveal"), () => {});
    clock.runFrame();

    expect(clock.pendingCount).toBe(0);
    expect(scheduler.isFrameArmed).toBe(false);
    expect(scheduler.pendingTaskCount).toBe(0);
  });

  test("quarantines a throwing task, finishes the phase, and reports it", () => {
    const { clock, scheduler } = constructScheduler();
    const diagnostics: AnimationFrameDiagnostic[] = [];
    scheduler.subscribeToDiagnostics((diagnostic) => {
      diagnostics.push(diagnostic);
    });
    const throwingKey = scheduler.claimTaskKey("throwing");
    let survivorRan = false;

    scheduler.scheduleRevealWork(throwingKey, () => {
      throw new Error("lane transition failed");
    });
    scheduler.scheduleRevealWork(scheduler.claimTaskKey("survivor"), () => {
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
    const { clock, scheduler } = constructScheduler();
    const diagnostics: AnimationFrameDiagnostic[] = [];
    scheduler.subscribeToDiagnostics((diagnostic) => {
      diagnostics.push(diagnostic);
    });

    scheduler.scheduleScrollWrite(scheduler.claimTaskKey("scroll"), () => {
      throw Object.create(null) as unknown;
    });

    expect(() => {
      clock.runFrame();
    }).not.toThrow();
    expect(diagnostics).toHaveLength(1);
  });

  test("cancel drops a submitted task", () => {
    const { clock, scheduler } = constructScheduler();
    const taskKey = scheduler.claimTaskKey("reveal");
    let ran = false;

    scheduler.scheduleRevealWork(taskKey, () => {
      ran = true;
    });
    scheduler.cancel("reveal-work", taskKey);
    clock.runFrame();

    expect(ran).toBe(false);
    // Canceling the last task releases the frame, so a settled scheduler holds no timer.
    expect(clock.pendingCount).toBe(0);
    // Idempotent: a second cancel of a key that never ran does nothing.
    expect(() => {
      scheduler.cancel("reveal-work", taskKey);
    }).not.toThrow();
  });

  test("a disposed scheduler accepts nothing and leaves no timer armed", () => {
    const { clock, scheduler } = constructScheduler();
    let ran = false;

    scheduler.scheduleRevealWork(scheduler.claimTaskKey("reveal"), () => {
      ran = true;
    });
    scheduler.dispose();

    expect(clock.pendingCount).toBe(0);
    expect(scheduler.isDisposed).toBe(true);

    scheduler.scheduleScrollWrite(scheduler.claimTaskKey("scroll"), () => {
      ran = true;
    });
    expect(scheduler.pendingTaskCount).toBe(0);
    clock.runFrame();
    expect(ran).toBe(false);
  });
});
