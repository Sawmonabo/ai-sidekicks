import { describe, expect, it } from "vitest";

import {
  type AdmissionWork,
  createMemoryGate,
  type MemoryAdmission,
  type MemoryGate,
} from "../memory-gate.js";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;
const PHYSICAL_BYTES = 16 * GIBIBYTE;
// A fifth of the 16 GiB machine, above the 1 GiB floor.
const HEADROOM_BYTES = 0.2 * PHYSICAL_BYTES;

const CLAUDE_TURN: AdmissionWork = { kind: "provider", provider: "claude" };

function quickStep(workflowNodeKey: string, budgetBytes = 0, inputBytes = 0): AdmissionWork {
  return { kind: "quick-code", workflowNodeKey, budgetBytes, inputBytes };
}

function bunStep(workflowNodeKey: string): AdmissionWork {
  return { kind: "script", runtime: "bun", workflowNodeKey };
}

interface GateOnMachine {
  readonly gate: MemoryGate;
  /** Moves the clock on, firing every timer that falls due. */
  advance(milliseconds: number): void;
}

// A gate on a machine whose memory reading stays at `availableBytes`, with a hand-moved clock.
function gateOnMachine(
  availableBytes: number,
  options: { physicalMemoryBytes?: number; peaksByProcess?: Map<number, number> } = {},
): GateOnMachine {
  let nowMs = 0;
  let timers: { dueAt: number; callback: () => void }[] = [];
  const peaksByProcess = options.peaksByProcess ?? new Map<number, number>();
  const gate = createMemoryGate({
    peakReader: { readPeakBytes: (processId) => Promise.resolve(peaksByProcess.get(processId)) },
    readAvailableMemory: () => availableBytes,
    physicalMemoryBytes: options.physicalMemoryBytes ?? PHYSICAL_BYTES,
    clock: {
      now: () => nowMs,
      schedule: (callback, delayMs) => {
        timers.push({ dueAt: nowMs + delayMs, callback });
      },
    },
  });
  return {
    gate,
    advance: (milliseconds) => {
      nowMs += milliseconds;
      const due = timers.filter((timer) => timer.dueAt <= nowMs);
      timers = timers.filter((timer) => timer.dueAt > nowMs);
      for (const timer of due) {
        timer.callback();
      }
    },
  };
}

function statesOf(admissions: readonly MemoryAdmission[]): string[] {
  return admissions.map((admission) => admission.state);
}

describe("the memory gate", () => {
  // Mutation: weighing the head against memory even when nothing is admitted leaves `first`
  // waiting forever on a full machine.
  it("admits exactly one entry on a full machine, and the next once it ends", async () => {
    const { gate } = gateOnMachine(0);
    const first = gate.enqueue(CLAUDE_TURN);
    const second = gate.enqueue(quickStep("small"));
    const third = gate.enqueue({ kind: "ingest", fileBytes: MEBIBYTE, picturePixels: 0 });
    expect(statesOf([first, second, third])).toEqual(["admitted", "waiting", "waiting"]);
    await expect(first.admitted()).resolves.toBe("admitted");

    first.release();
    expect(statesOf([second, third])).toEqual(["admitted", "waiting"]);
  });

  // Mutation: letting a fitting entry behind the head start first (first fit) admits `smaller`
  // while `large` still waits.
  it("never lets a smaller entry pass the head of the line", () => {
    const { gate } = gateOnMachine(HEADROOM_BYTES + 200 * MEBIBYTE);
    const running = gate.enqueue(quickStep("running"));
    const large = gate.enqueue(CLAUDE_TURN);
    const smaller = gate.enqueue(quickStep("smaller"));
    expect(statesOf([running, large, smaller])).toEqual(["admitted", "waiting", "waiting"]);

    // Nothing else is admitted, so the head starts whatever its size, and holds the rest back.
    running.release();
    expect(statesOf([large, smaller])).toEqual(["admitted", "waiting"]);

    large.release();
    expect(smaller.state).toBe("admitted");
  });

  // Mutations: dropping the spacing admits `secondEstimate` at once; spacing quick steps too
  // keeps `quickAfterStart` waiting; letting the one-step rule skip the spacing admits `next`.
  it("spaces estimated starts 1.5 s apart and starts a quick step as soon as it fits", () => {
    const { gate, advance } = gateOnMachine(64 * GIBIBYTE);
    const firstEstimate = gate.enqueue(bunStep("first"));
    const secondEstimate = gate.enqueue({ kind: "script", runtime: "python" });
    const quickBehind = gate.enqueue(quickStep("behind"));
    expect(statesOf([firstEstimate, secondEstimate, quickBehind])).toEqual([
      "admitted",
      "waiting",
      "waiting",
    ]);

    advance(1_499);
    expect(secondEstimate.state).toBe("waiting");
    advance(1);
    expect(statesOf([secondEstimate, quickBehind])).toEqual(["admitted", "admitted"]);

    const quickAfterStart = gate.enqueue(quickStep("after"));
    expect(quickAfterStart.state).toBe("admitted");

    // With nothing admitted the next estimate still waits out the spacing before it starts.
    const idle = gateOnMachine(64 * GIBIBYTE);
    const ended = idle.gate.enqueue(bunStep("ended"));
    const next = idle.gate.enqueue(bunStep("next"));
    ended.release();
    expect(next.state).toBe("waiting");
    idle.advance(1_500);
    expect(next.state).toBe("admitted");
  });

  // Mutations: not subtracting held reservations admits `third` beside the other two; a headroom
  // of 1 GiB on the 16 GiB machine, or of a fifth on the 4 GiB one, admits what must wait.
  it("keeps every admitted reservation and the headroom off the reading until release", () => {
    const { gate, advance } = gateOnMachine(HEADROOM_BYTES + 600 * MEBIBYTE);
    const first = gate.enqueue(CLAUDE_TURN);
    advance(1_500);
    const second = gate.enqueue(CLAUDE_TURN);
    advance(1_500);
    const third = gate.enqueue(CLAUDE_TURN);
    expect(statesOf([first, second, third])).toEqual(["admitted", "admitted", "waiting"]);

    first.release();
    expect(third.state).toBe("admitted");

    // On a 4 GiB machine a fifth is under the 1 GiB floor, so the floor is what stays free.
    const small = gateOnMachine(GIBIBYTE + 300 * MEBIBYTE, { physicalMemoryBytes: 4 * GIBIBYTE });
    const quick = small.gate.enqueue(quickStep("quick"));
    const turn = small.gate.enqueue(CLAUDE_TURN);
    expect(statesOf([quick, turn])).toEqual(["admitted", "waiting"]);
  });

  // Mutations: a park that keeps its reservation leaves `waiting` held; a resume admitted
  // without taking its reservation again admits `quick` beside it.
  it("frees a parked entry's reservation and takes it again when it resumes", () => {
    const { gate, advance } = gateOnMachine(HEADROOM_BYTES + 332 * MEBIBYTE);
    // Something stays admitted throughout, so no admission below is the one-step rule's.
    gate.enqueue(quickStep("running"));
    const parked = gate.enqueue(CLAUDE_TURN);
    advance(1_500);
    const waiting = gate.enqueue(CLAUDE_TURN);
    expect(statesOf([parked, waiting])).toEqual(["admitted", "waiting"]);

    parked.park();
    expect(statesOf([parked, waiting])).toEqual(["parked", "admitted"]);

    parked.resume();
    expect(parked.state).toBe("waiting");
    waiting.release();
    // The resume is an estimated start, so it waits out the spacing from the last one.
    expect(parked.state).toBe("waiting");
    advance(1_500);
    expect(parked.state).toBe("admitted");

    const quick = gate.enqueue(quickStep("quick"));
    expect(quick.state).toBe("waiting");
  });

  // Mutation: a release that learns nothing keeps the starting figures, admitting `rerun` at
  // 160 MiB and `quickRerun` waiting at its 256 MiB budget.
  it("moves a node's reservation from its starting figure to the peak it reached", async () => {
    const processId = 4_242;
    const { gate, advance } = gateOnMachine(HEADROOM_BYTES + 400 * MEBIBYTE, {
      peaksByProcess: new Map([[processId, 500 * MEBIBYTE]]),
    });
    const firstRun = gate.enqueue(bunStep("build"));
    await firstRun.observeProcessPeak(processId);
    firstRun.release();

    const running = gate.enqueue(quickStep("running"));
    advance(1_500);
    const rerun = gate.enqueue(bunStep("build"));
    expect(rerun.state).toBe("waiting");
    rerun.release();

    // A node that never ran takes its kind's peak; another kind keeps its starting figure.
    const sameKind = gate.enqueue(bunStep("never-ran"));
    expect(sameKind.state).toBe("waiting");
    sameKind.release();
    const otherKind = gate.enqueue({ kind: "script", runtime: "python" });
    expect(otherKind.state).toBe("admitted");
    otherKind.release();
    running.release();

    // A quick node's budget gives way to its interpreter's peak, beside its thread and 9× input.
    const quickGate = gateOnMachine(HEADROOM_BYTES + 89 * MEBIBYTE).gate;
    const quickFirst = quickGate.enqueue(quickStep("transform", 256 * MEBIBYTE, MEBIBYTE));
    quickFirst.observeInterpreterPeak(16 * MEBIBYTE);
    quickFirst.release();
    quickGate.enqueue(quickStep("guard"));
    const quickRerun = quickGate.enqueue(quickStep("transform", 256 * MEBIBYTE, MEBIBYTE));
    expect(quickRerun.state).toBe("admitted");
  });
});
