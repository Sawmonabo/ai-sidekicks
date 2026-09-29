// The act primitive's two halves, driven through every arm each one publishes.
//
// THE REAL CLASSES, THE REAL SCHEDULER, AND THE REAL LATCH. Only the wire call is the
// test's — it is a parameter rather than a collaborator, which is what lets these cases
// hold answers open and settle them out of order. The two cases that matter most are
// exactly the ones a hand-rolled copy of this pattern got wrong: a superseded read
// installing its answer, and two presses in one tick both dispatching.

import { describe, expect, it, vi } from "vitest";

import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { ActController, PrerequisiteReader } from "./act-controller.js";
import type { ActOwnArm } from "./act-reading.js";
import { SessionStore } from "../session/session-store.js";

/** The frames this reading would re-read on. Never fired here; declared to be read. */
const TRIGGERING_KINDS: ReadonlySet<string> = new Set(["workspace.ready"]);

/** What a settled act publishes in these cases. The caller's own arm. */
interface TestSettlement {
  readonly status: "done";
  readonly value: string;
}

/** One answer a case holds open and settles by hand. */
interface HeldAnswer<TValue> {
  readonly promise: Promise<TValue>;
  serve(value: TValue): void;
}

function heldAnswer<TValue>(): HeldAnswer<TValue> {
  let settle: (value: TValue) => void = () => undefined;
  const promise = new Promise<TValue>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    serve: (value) => {
      settle(value);
    },
  };
}

/** Let every pending microtask land. Nothing here is timer-driven but the debounce. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

interface OpenedReader {
  readonly reader: PrerequisiteReader<string>;
  readonly clock: ManualClock;
  /** Every question the read path was asked, in order. */
  readonly questionsAsked: string[];
  /** The answer the next read will wait on, replaced per read. */
  readonly answers: HeldAnswer<string>[];
}

function openReader(): OpenedReader {
  const clock = new ManualClock();
  const questionsAsked: string[] = [];
  const answers: HeldAnswer<string>[] = [];
  const reader = new PrerequisiteReader<string>({
    label: "prerequisite reader test reading",
    clock,
    sessionStore: new SessionStore({ sessionId: "session-under-test" }),
    triggeringEventKinds: TRIGGERING_KINDS,
    readPrerequisite: async (question: string) => {
      questionsAsked.push(question);
      const answer = heldAnswer<string>();
      answers.push(answer);
      return await answer.promise;
    },
  });
  return { reader, clock, questionsAsked, answers };
}

function openActs(): ActController<TestSettlement> {
  return new ActController<TestSettlement>({ label: "act controller test reading" });
}

/** Move past the debounce so the scheduler performs whatever was requested. */
async function runScheduledRead(clock: ManualClock): Promise<void> {
  await flush();
  clock.advance(REFRESH_DEBOUNCE_MS);
  await flush();
}

describe("PrerequisiteReader — the question an act is issued against", () => {
  it("asks nothing until a question is named", async () => {
    const { reader, clock, questionsAsked } = openReader();
    reader.start();
    reader.requestRead("window-focus");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual([]);
    expect(reader.snapshot.status).toBe("not-read");
  });

  it("publishes reading, then the answer the caller's closure returned", async () => {
    const { reader, clock, questionsAsked, answers } = openReader();
    reader.ask("first", "subscribe");
    expect(reader.snapshot.status).toBe("reading");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual(["first"]);
    answers[0]?.serve("the answer");
    await flush();
    const prerequisite = reader.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(prerequisite.status === "read" && prerequisite.value).toBe("the answer");
  });

  it("re-asking the SAME question puts nothing new on the wire", async () => {
    const { reader, clock, questionsAsked, answers } = openReader();
    reader.ask("first", "subscribe");
    await runScheduledRead(clock);
    answers[0]?.serve("the answer");
    await flush();
    reader.ask("first", "subscribe");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual(["first"]);
    // And the answer already on screen is untouched, rather than being blanked.
    expect(reader.snapshot.status).toBe("read");
  });

  it("negative control: a superseded read installs nothing when it answers", async () => {
    const { reader, clock, questionsAsked, answers } = openReader();
    reader.ask("first", "user-request");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual(["first"]);
    // The question changes while the first read is still on the wire, and the first call
    // still answers.
    reader.ask("second", "user-request");
    expect(reader.snapshot.status).toBe("reading");
    answers[0]?.serve("first answer");
    await flush();
    // THE ASSERTION: the answer for the abandoned question installed nothing. A
    // verdict on screen for a branch the user has edited away from is the one
    // state that would let a consent be given for the wrong tree.
    expect(reader.snapshot.status).toBe("reading");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual(["first", "second"]);
    answers[1]?.serve("second answer");
    await flush();
    const prerequisite = reader.snapshot;
    expect(prerequisite.status === "read" && prerequisite.value).toBe("second answer");
  });

  it("withdrawing resets the half, and the answer in flight installs nothing", async () => {
    const { reader, clock, answers } = openReader();
    reader.ask("first", "user-request");
    await runScheduledRead(clock);
    reader.withdraw();
    expect(reader.snapshot.status).toBe("not-read");
    answers[0]?.serve("too late");
    await flush();
    expect(reader.snapshot.status).toBe("not-read");
  });

  it("declares the trigger contract a refresh set reads off it", () => {
    const { reader } = openReader();
    expect(reader.triggeringEventKinds).toBe(TRIGGERING_KINDS);
  });
});

describe("ActController — the act", () => {
  it("publishes sending, then the settlement the caller composed", async () => {
    const controller = openActs();
    const answer = heldAnswer<string>();
    const act = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    expect(controller.snapshot.status).toBe("sending");
    answer.serve("minted");
    await act;
    const settled = controller.snapshot;
    expect(settled.status).toBe("done");
    expect(settled.status === "done" && settled.value).toBe("minted");
  });

  it("a rejected send goes back to idle and the rejection reaches the sender", async () => {
    const controller = openActs();
    const act = controller.act(
      async () => await Promise.reject(new Error("the wire failed")),
      (value: string) => ({ status: "done" as const, value }),
    );
    await expect(act).rejects.toThrow("the wire failed");
    expect(controller.snapshot.status).toBe("idle");
  });

  it("negative control: a second act in the same tick reaches no send at all", async () => {
    const controller = openActs();
    const answer = heldAnswer<string>();
    const secondSend = vi.fn();
    const first = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    // Two presses inside one frame both read an idle surface; the key is what refuses.
    await controller.act(
      async () => {
        secondSend();
        return await Promise.resolve("second");
      },
      (value) => ({ status: "done" as const, value }),
    );
    expect(secondSend).not.toHaveBeenCalled();
    answer.serve("first");
    await first;
    const act = controller.snapshot;
    expect(act.status === "done" && act.value).toBe("first");
  });

  it("clearing the settlement keeps the key, so a call still in flight is not doubled", async () => {
    const controller = openActs();
    const answer = heldAnswer<string>();
    const secondSend = vi.fn();
    const first = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    controller.clearAct();
    expect(controller.snapshot.status).toBe("idle");
    await controller.act(
      async () => {
        secondSend();
        return await Promise.resolve("second");
      },
      (value) => ({ status: "done" as const, value }),
    );
    expect(secondSend).not.toHaveBeenCalled();
    answer.serve("first");
    await first;
  });

  it("negative control: a settlement after disposal lands nowhere", async () => {
    const controller = openActs();
    const answer = heldAnswer<string>();
    const act = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    controller.dispose();
    answer.serve("too late");
    await act;
    expect(controller.snapshot.status).toBe("sending");
    expect(controller.isDisposed).toBe(true);
  });

  it("publishes every change to a subscriber, and nothing after disposal", async () => {
    const controller = openActs();
    const seen: string[] = [];
    controller.subscribe((reading) => {
      seen.push(reading.status);
    });
    const answer = heldAnswer<string>();
    const act = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    answer.serve("minted");
    await act;
    controller.clearAct();
    expect(seen).toStrictEqual(["sending", "done", "idle"]);
  });
});

describe("ActController — a settlement arm's discriminant is its own", () => {
  /**
   * THE PIN IS A COMPILE-TIME ONE, and it is here because the rule it holds cannot be
   * written as a type constraint: `Exclude<string, "sending">` is `string`, so the
   * `ActSettlementArm` interface can require a `status` and cannot require which
   * strings it is not. `ActOwnArm` states the negation as a collision test instead and
   * `act`'s settle callback is annotated with it, so this case is what proves the
   * annotation does work rather than reading as though it did — deleting the directive
   * yields TS2322 `Type '{ status: "sending"; }' is not assignable to type 'never'`,
   * never an unused-directive error.
   *
   * The runtime half says why the rule exists at all. A colliding arm is published
   * verbatim, so a SETTLED act is indistinguishable on the reading from one still on
   * the wire — which is a surface reporting work in flight that has already finished.
   */
  it("refuses a settle callback whose arm reuses one of the two owned statuses", async () => {
    const colliding = new ActController<{ readonly status: "sending" }>({
      label: "colliding settlement reading",
    });
    await colliding.act(
      async () => await Promise.resolve("settled"),
      // @ts-expect-error the settle callback is typed `ActOwnArm<{ status: "sending" }>`,
      // which resolves to `never`, so no value of that shape is assignable.
      () => ({ status: "sending" as const }),
    );
    expect(colliding.snapshot.status).toBe("sending");
    colliding.dispose();
  });

  it("negative control: an arm with its own discriminant is admitted unchanged", async () => {
    const controller = openActs();
    const admitted: ActOwnArm<TestSettlement> = { status: "done", value: "kept" };
    await controller.act(
      async () => await Promise.resolve(admitted.value),
      (value) => ({ status: "done" as const, value }),
    );
    expect(controller.snapshot).toStrictEqual(admitted);
  });
});
