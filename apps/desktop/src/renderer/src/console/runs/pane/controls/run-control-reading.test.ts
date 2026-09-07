// Which settlement a row is in, the one refusal that ends the run rather than the
// act, and the ordering that decides which settlement is "newest".
//
// Driven on the records directly rather than through a mounted row: the reading is a
// walk over what the surface holds, and every claim here is about that walk.
//
// THE FAILURE MATRIX COMES FIRST, because the defect it pins is invisible to a case
// written one dispatch at a time. Different controls for one run are admitted
// concurrently and a record is appended when its promise SETTLES, so the array's
// order is completion order. Each row below names a dispatch order and a settlement
// order that disagree, and states what the row must be in afterwards — and the row
// that matters is the first: a newer `run.not_found` followed by an older request's
// late success used to clear `isGone` and hand back every control on a run the daemon
// had already said was absent.

import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import { goneRunIds, readRunControlSettlement } from "./run-control-reading.js";
import type { RunControlAck } from "@ai-sidekicks/contracts";
import { type RunControl, type RunControlOutcome } from "./run-control-dispatch.js";
import { mintRunControlDispatchToken } from "./run-control-dispatch-token.js";
import { type RunControlRecord, type RunControlSurface } from "./run-control-surface.js";

const FIRST_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const SECOND_RUN = "c4a1b2d3-5e6f-4071-8b82-0d3e4f506172";

/** One dispatch, named by the ordinal it was admitted under and how it came back. */
interface DispatchedSettlement {
  /** The surface's own monotonic dispatch counter. Request order, not append order. */
  readonly ordinal: number;
  /** The wire code it refused with, or nothing where the daemon acknowledged it. */
  readonly refusedWith?: string;
  readonly control?: RunControl;
}

/**
 * One record, with the token the surface would really have minted for it.
 *
 * The token comes from `mintRunControlDispatchToken` rather than a literal, so a
 * change to that encoding fails these cases instead of leaving them asserting about
 * a shape the surface no longer produces.
 */
function recordFor(runId: string, dispatched: DispatchedSettlement): RunControlRecord {
  const control: RunControl = dispatched.control ?? "pause";
  const outcome: RunControlOutcome =
    dispatched.refusedWith === undefined
      ? {
          kind: "acknowledged",
          control,
          ack: { runId, currentState: "paused", runVersion: 8 } as RunControlAck,
        }
      : {
          kind: "refused",
          control,
          refusal: refuse("run-control", dispatched.refusedWith, "…"),
        };
  return {
    recordId: mintRunControlDispatchToken(runId, control, dispatched.ordinal),
    runId,
    control,
    outcome,
  };
}

/** A surface holding exactly the records a case is about. Nothing else is read. */
function surfaceHolding(records: readonly RunControlRecord[]): RunControlSurface {
  return {
    dispatcher: {} as RunControlSurface["dispatcher"],
    records,
    inFlightKeys: new Set<string>(),
    dispatch: () => ({ admitted: true, dispatchToken: "token" }),
  };
}

/** One run's records, in the order their promises settled — which is append order. */
function settledInOrder(
  runId: string,
  dispatches: readonly DispatchedSettlement[],
): RunControlSurface {
  return surfaceHolding(dispatches.map((dispatched) => recordFor(runId, dispatched)));
}

interface OrderingCase {
  readonly name: string;
  readonly settled: readonly DispatchedSettlement[];
  readonly refusalCode: string | undefined;
  readonly isGone: boolean;
}

/**
 * The matrix. Every row settles OUT of dispatch order except the two that state the
 * in-order readings, which are what keep the fix from being "the oldest wins".
 */
const ORDERING_CASES: readonly OrderingCase[] = [
  {
    name: "an older request's late success never clears a newer run-loss verdict",
    settled: [{ ordinal: 2, refusedWith: "run.not_found", control: "cancel" }, { ordinal: 1 }],
    refusalCode: "run.not_found",
    isGone: true,
  },
  {
    name: "an older run-loss verdict settling last does not take the run away",
    settled: [{ ordinal: 2 }, { ordinal: 1, refusedWith: "run.not_found", control: "cancel" }],
    refusalCode: undefined,
    isGone: false,
  },
  {
    name: "an older refusal settling last does not supersede a newer one",
    settled: [
      { ordinal: 2, refusedWith: "run.invalid_transition", control: "resume" },
      { ordinal: 1, refusedWith: "run.version_conflict" },
    ],
    refusalCode: "run.invalid_transition",
    isGone: false,
  },
  {
    name: "settlements that arrived in dispatch order read as they always did",
    settled: [{ ordinal: 1, refusedWith: "run.version_conflict" }, { ordinal: 2 }],
    refusalCode: undefined,
    isGone: false,
  },
  {
    name: "a newer run-loss verdict settling last still takes the run away",
    settled: [{ ordinal: 1 }, { ordinal: 2, refusedWith: "run.not_found", control: "cancel" }],
    refusalCode: "run.not_found",
    isGone: true,
  },
];

describe("which settlement the row is in, when settlement order is not dispatch order", () => {
  it("covers five orderings, two of them in dispatch order", () => {
    // Vacuity guard: every case below iterates this list.
    expect(ORDERING_CASES).toHaveLength(5);
  });

  it.each(ORDERING_CASES.map((entry) => [entry.name, entry] as const))("%s", (_name, ordering) => {
    const reading = readRunControlSettlement(
      settledInOrder(FIRST_RUN, ordering.settled),
      FIRST_RUN,
    );

    expect(reading.refusal?.code).toBe(ordering.refusalCode);
    expect(reading.isGone).toBe(ordering.isGone);
  });

  it("negative control: append order alone answers two of these five differently", () => {
    // What a walk that trusted completion order would say. Written as the reading it
    // is NOT, so the matrix above cannot be satisfied by a walk that ignores the
    // ordinal and happens to agree on the in-order rows.
    const byAppendOrder = ORDERING_CASES.map((ordering) => ordering.settled.at(-1)?.refusedWith);
    const byDispatchOrder = ORDERING_CASES.map((ordering) => ordering.refusalCode);

    expect(byAppendOrder).not.toStrictEqual(byDispatchOrder);
  });
});

describe("which settlement the row is in", () => {
  it("answers with the newest settlement for this run and no earlier one", () => {
    // A refusal superseded by a control that worked is not what the row is in, and
    // leaving it up would report a state the daemon has moved past.
    const surface = settledInOrder(FIRST_RUN, [
      { ordinal: 1, refusedWith: "run.version_conflict" },
      { ordinal: 2 },
    ]);

    expect(readRunControlSettlement(surface, FIRST_RUN).refusal).toBeUndefined();
  });

  it("reads past another run's newer settlement to reach this run's own", () => {
    const surface = surfaceHolding([
      recordFor(FIRST_RUN, { ordinal: 1, refusedWith: "run.version_conflict" }),
      recordFor(SECOND_RUN, { ordinal: 2 }),
    ]);

    expect(readRunControlSettlement(surface, FIRST_RUN).refusal?.code).toBe("run.version_conflict");
  });

  it("ranks each run's dispatches among its own, never across runs", () => {
    // The ordinal is the surface's, so it is monotonic across every run at once. A
    // walk that compared this run's records against another run's would answer about
    // whichever run dispatched last.
    const surface = surfaceHolding([
      recordFor(FIRST_RUN, { ordinal: 3, refusedWith: "run.not_found", control: "cancel" }),
      recordFor(SECOND_RUN, { ordinal: 4 }),
      recordFor(FIRST_RUN, { ordinal: 1 }),
    ]);

    expect(readRunControlSettlement(surface, FIRST_RUN).isGone).toBe(true);
    expect(readRunControlSettlement(surface, SECOND_RUN).isGone).toBe(false);
  });

  it("answers with nothing for a run this surface has never dispatched against", () => {
    const surface = settledInOrder(FIRST_RUN, [{ ordinal: 1 }]);
    const reading = readRunControlSettlement(surface, SECOND_RUN);

    expect(reading.refusal).toBeUndefined();
    expect(reading.isGone).toBe(false);
  });

  it("falls back to append order for a token carrying no ordinal", () => {
    // A record whose id this module cannot read ranks below every one it can, and
    // ties among those break on append position — which is exactly the reading this
    // walk had before the ordinal existed, kept for a surface whose tokens are not
    // the ones minted beside it.
    const surface = surfaceHolding([
      { ...recordFor(FIRST_RUN, { ordinal: 1, refusedWith: "run.not_found" }), recordId: "one" },
      { ...recordFor(FIRST_RUN, { ordinal: 2 }), recordId: "two" },
    ]);

    expect(readRunControlSettlement(surface, FIRST_RUN).isGone).toBe(false);
  });

  it("never lets an unreadable token outrank a real ordinal", () => {
    // The other side of that fallback: an unreadable token is not evidence of
    // anything, so it must not displace a verdict the surface can actually rank.
    const surface = surfaceHolding([
      recordFor(FIRST_RUN, { ordinal: 4, refusedWith: "run.not_found", control: "cancel" }),
      { ...recordFor(FIRST_RUN, { ordinal: 1 }), recordId: "unreadable" },
    ]);

    expect(readRunControlSettlement(surface, FIRST_RUN).isGone).toBe(true);
  });
});

describe("the one refusal that means the run is gone", () => {
  it("reads `run.not_found` as gone", () => {
    const surface = settledInOrder(FIRST_RUN, [{ ordinal: 1, refusedWith: "run.not_found" }]);

    expect(readRunControlSettlement(surface, FIRST_RUN).isGone).toBe(true);
  });

  it.each([
    ["a stale comparand", "run.version_conflict"],
    ["a transition the run does not admit", "run.invalid_transition"],
    ["a driver that cannot do it", "driver.capability_unsupported"],
    ["a vanished session", "session.not_found"],
  ])("negative control: %s leaves the run there", (_name, code) => {
    // Every other refusal is about the ACT. The same control may work on the next
    // press, and withdrawing the strip for one would take away a control that works.
    const surface = settledInOrder(FIRST_RUN, [{ ordinal: 1, refusedWith: code }]);
    const reading = readRunControlSettlement(surface, FIRST_RUN);

    expect(reading.refusal?.code).toBe(code);
    expect(reading.isGone).toBe(false);
  });

  it("stops being gone once a LATER-DISPATCHED control settled another way", () => {
    // Not a hypothetical: the daemon answering `run.not_found` and then answering at
    // all is a disagreement, and the newest REQUEST's answer is the one the row is in.
    const surface = settledInOrder(FIRST_RUN, [
      { ordinal: 1, refusedWith: "run.not_found" },
      { ordinal: 2 },
    ]);

    expect(readRunControlSettlement(surface, FIRST_RUN).isGone).toBe(false);
  });
});

describe("every gone run, as one set", () => {
  it("names each run whose newest settlement said so, once", () => {
    const surface = surfaceHolding([
      recordFor(FIRST_RUN, { ordinal: 1, refusedWith: "run.not_found" }),
      recordFor(FIRST_RUN, { ordinal: 2, refusedWith: "run.not_found", control: "cancel" }),
      recordFor(SECOND_RUN, { ordinal: 3, refusedWith: "run.version_conflict" }),
    ]);

    expect([...goneRunIds(surface)]).toStrictEqual([FIRST_RUN]);
  });

  it("names nobody on a surface that has settled nothing", () => {
    expect([...goneRunIds(surfaceHolding([]))]).toStrictEqual([]);
  });
});
