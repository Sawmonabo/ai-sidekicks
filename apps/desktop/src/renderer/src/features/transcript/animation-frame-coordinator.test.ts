import { beforeEach, describe, expect, test } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { developmentPerformanceMeters } from "@renderer/lib/performance-meters/performance-meters.js";
import {
  AnimationFrameCoordinator,
  type AnimationFrameDiagnostic,
} from "./animation-frame-coordinator.js";

const constructCoordinator = (): { clock: ManualClock; coordinator: AnimationFrameCoordinator } => {
  const clock = new ManualClock();
  return { clock, coordinator: new AnimationFrameCoordinator({ clock }) };
};

describe("AnimationFrameCoordinator", () => {
  beforeEach(() => {
    developmentPerformanceMeters?.reset();
  });

  test("runs scroll writes before reveal work, whatever order they were submitted in", () => {
    const { clock, coordinator } = constructCoordinator();
    const order: string[] = [];

    // Submitted in the wrong order on purpose.
    coordinator.scheduleRevealWork(coordinator.claimTaskKey("reveal"), () => {
      order.push("reveal");
    });
    coordinator.scheduleScrollWrite(coordinator.claimTaskKey("scroll"), () => {
      order.push("scroll");
    });

    clock.runFrame();

    expect(order).toEqual(["scroll", "reveal"]);
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
    // Negative control: draining the deferred write inside this frame would put `scroll`
    // after `reveal`.
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
    const diagnostics: AnimationFrameDiagnostic[] = [];
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
    const diagnostics: AnimationFrameDiagnostic[] = [];
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
    // Canceling the last task releases the frame, so a settled coordinator holds no timer.
    expect(clock.pendingCount).toBe(0);
    // Idempotent: a second cancel of a key that never ran does nothing.
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
