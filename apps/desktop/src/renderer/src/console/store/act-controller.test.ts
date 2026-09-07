// The act primitive, driven through every arm of both halves.
//
// THE REAL CLASS, THE REAL SCHEDULER, AND THE REAL LATCH. Only the wire call is the
// test's — it is a parameter of the class rather than a collaborator, which is what
// lets these cases hold answers open and settle them out of order. The two cases that
// matter most are exactly the ones a hand-rolled copy of this pattern got wrong: a
// superseded read installing its answer, and two presses in one tick both dispatching.

import { describe, expect, it, vi } from "vitest";

import { ManualClock, REFRESH_DEBOUNCE_MS, refuse, type ConsoleRefusal } from "../core/index.js";
import { ActController } from "./act-controller.js";
import type { ActOutcome, ActOwnArm } from "./act-reading.js";
import { SessionStore } from "./session-store.js";

/** The subsystem these refusals name as their author. */
const TEST_ORIGIN = "act-controller-test";

/** The frames this reading would re-read on. Never fired here; declared to be read. */
const TRIGGERING_KINDS: ReadonlySet<string> = new Set(["repo.mount_attached"]);

/** What a settled act publishes in these cases. The caller's own arm. */
interface TestSettlement {
  readonly status: "done";
  readonly value: string;
}

/** One answer a case holds open and settles by hand. */
interface HeldAnswer<TValue> {
  readonly promise: Promise<ActOutcome<TValue>>;
  serve(value: TValue): void;
  refuseWith(refusal: ConsoleRefusal): void;
  reject(rejection: unknown): void;
}

function heldAnswer<TValue>(): HeldAnswer<TValue> {
  let settle: (outcome: ActOutcome<TValue>) => void = () => undefined;
  let fail: (rejection: unknown) => void = () => undefined;
  const promise = new Promise<ActOutcome<TValue>>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return {
    promise,
    serve: (value) => {
      settle({ status: "served", value });
    },
    refuseWith: (refusal) => {
      settle({ status: "refused", refusal });
    },
    reject: (rejection) => {
      fail(rejection);
    },
  };
}

/** A refusal shaped the way the console's own vocabulary shapes one. */
function testRefusal(code: string): ConsoleRefusal {
  return refuse(TEST_ORIGIN, code, "The wire said no.");
}

/** Let every pending microtask land. Nothing here is timer-driven but the debounce. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

interface OpenedController {
  readonly controller: ActController<string, TestSettlement>;
  readonly clock: ManualClock;
  /** Every question the read path was asked, in order. */
  readonly questionsAsked: string[];
  /** The answer the next read will wait on, replaced per read. */
  readonly answers: HeldAnswer<string>[];
}

function open(): OpenedController {
  const clock = new ManualClock();
  const questionsAsked: string[] = [];
  const answers: HeldAnswer<string>[] = [];
  const controller = new ActController<string, TestSettlement>({
    label: "act controller test reading",
    clock,
    sessionStore: new SessionStore({ sessionId: "session-under-test" }),
    triggeringEventKinds: TRIGGERING_KINDS,
    refusalOrigin: TEST_ORIGIN,
    readPrerequisite: async (question: string) => {
      questionsAsked.push(question);
      const answer = heldAnswer<string>();
      answers.push(answer);
      return await answer.promise;
    },
    readRejection: { code: "call-rejected", detail: "The read did not complete." },
  });
  return { controller, clock, questionsAsked, answers };
}

/** Move past the debounce so the scheduler performs whatever was requested. */
async function runScheduledRead(clock: ManualClock): Promise<void> {
  await flush();
  clock.advance(REFRESH_DEBOUNCE_MS);
  await flush();
}

describe("ActController — the prerequisite half", () => {
  it("asks nothing until a question is named", async () => {
    const { controller, clock, questionsAsked } = open();
    controller.start();
    controller.requestRead("window-focus");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual([]);
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });

  it("publishes reading, then the answer the caller's closure returned", async () => {
    const { controller, clock, questionsAsked, answers } = open();
    controller.ask("first", "subscribe");
    expect(controller.snapshot.prerequisite.status).toBe("reading");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual(["first"]);
    answers[0]?.serve("the answer");
    await flush();
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(prerequisite.status === "read" && prerequisite.value).toBe("the answer");
  });

  it("re-asking the SAME question puts nothing new on the wire", async () => {
    const { controller, clock, questionsAsked, answers } = open();
    controller.ask("first", "subscribe");
    await runScheduledRead(clock);
    answers[0]?.serve("the answer");
    await flush();
    controller.ask("first", "subscribe");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual(["first"]);
    // And the answer already on screen is untouched, rather than being blanked.
    expect(controller.snapshot.prerequisite.status).toBe("read");
  });

  it("negative control: a superseded read installs nothing when it answers", async () => {
    const { controller, clock, questionsAsked, answers } = open();
    controller.ask("first", "participant-request");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual(["first"]);
    // The question changes while the first read is still on the wire. Nothing is
    // cancelled — nothing behind a bridge is — so the first call still answers.
    controller.ask("second", "participant-request");
    expect(controller.snapshot.prerequisite.status).toBe("reading");
    answers[0]?.serve("first answer");
    await flush();
    // THE ASSERTION: the answer for the abandoned question installed nothing. A
    // verdict on screen for a branch the participant has edited away from is the one
    // state that would let a consent be given for the wrong tree.
    expect(controller.snapshot.prerequisite.status).toBe("reading");
    await runScheduledRead(clock);
    expect(questionsAsked).toStrictEqual(["first", "second"]);
    answers[1]?.serve("second answer");
    await flush();
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status === "read" && prerequisite.value).toBe("second answer");
  });

  it("withdrawing resets the half, and the answer in flight installs nothing", async () => {
    const { controller, clock, answers } = open();
    controller.ask("first", "participant-request");
    await runScheduledRead(clock);
    controller.withdraw();
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
    answers[0]?.serve("too late");
    await flush();
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });

  it("carries the wire's own refusal verbatim", async () => {
    const { controller, clock, answers } = open();
    controller.ask("first", "subscribe");
    await runScheduledRead(clock);
    answers[0]?.refuseWith(testRefusal("repo.not_found"));
    await flush();
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status === "refused" && prerequisite.refusal.code).toBe("repo.not_found");
    expect(prerequisite.status === "refused" && prerequisite.refusal.detail).toBe(
      "The wire said no.",
    );
  });

  it("reads a rejection as an answer, through the caller's own fallback", async () => {
    const { controller, clock, answers } = open();
    controller.ask("first", "subscribe");
    await runScheduledRead(clock);
    answers[0]?.reject(new Error("the namespace is gone"));
    await flush();
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("refused");
    expect(prerequisite.status === "refused" && prerequisite.refusal.code).toBe("call-rejected");
  });

  it("declares the trigger contract a refresh set reads off it", () => {
    const { controller } = open();
    expect(controller.triggeringEventKinds).toBe(TRIGGERING_KINDS);
  });
});

describe("ActController — the act half", () => {
  it("publishes sending, then the settlement the caller composed", async () => {
    const { controller } = open();
    const answer = heldAnswer<string>();
    const act = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    expect(controller.snapshot.act.status).toBe("sending");
    answer.serve("minted");
    await act;
    const { act: settled } = controller.snapshot;
    expect(settled.status).toBe("done");
    expect(settled.status === "done" && settled.value).toBe("minted");
  });

  it("carries the daemon's refusal rather than swallowing it", async () => {
    const { controller } = open();
    const answer = heldAnswer<string>();
    const act = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    answer.refuseWith(testRefusal("repo.already_attached"));
    await act;
    const { act: settled } = controller.snapshot;
    expect(settled.status === "refused" && settled.refusal.code).toBe("repo.already_attached");
  });

  it("reads a rejection as a refusal rather than leaving the surface sending", async () => {
    const { controller } = open();
    const answer = heldAnswer<string>();
    const act = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    answer.reject(new Error("the namespace is gone"));
    await act;
    expect(controller.snapshot.act.status).toBe("refused");
  });

  it("negative control: a second act in the same tick reaches no send at all", async () => {
    const { controller } = open();
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
        return { status: "served", value: "second" };
      },
      (value) => ({ status: "done" as const, value }),
    );
    expect(secondSend).not.toHaveBeenCalled();
    answer.serve("first");
    await first;
    const { act } = controller.snapshot;
    expect(act.status === "done" && act.value).toBe("first");
  });

  it("clearing the settlement keeps the key, so a call still in flight is not doubled", async () => {
    const { controller } = open();
    const answer = heldAnswer<string>();
    const secondSend = vi.fn();
    const first = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    controller.clearAct();
    expect(controller.snapshot.act.status).toBe("idle");
    await controller.act(
      async () => {
        secondSend();
        return { status: "served", value: "second" };
      },
      (value) => ({ status: "done" as const, value }),
    );
    expect(secondSend).not.toHaveBeenCalled();
    answer.serve("first");
    await first;
  });

  it("negative control: a settlement after disposal lands nowhere", async () => {
    const { controller } = open();
    const answer = heldAnswer<string>();
    const act = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    controller.dispose();
    answer.serve("too late");
    await act;
    expect(controller.snapshot.act.status).toBe("sending");
    expect(controller.isDisposed).toBe(true);
  });

  it("publishes every change to a subscriber, and nothing after disposal", async () => {
    const { controller } = open();
    const seen: string[] = [];
    controller.subscribe((reading) => {
      seen.push(reading.act.status);
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
   * annotation does work rather than reading as though it did — measured: deleting the
   * directive yields TS2322 `Type '{ status: "sending"; }' is not assignable to type
   * 'never'`, never an unused-directive error.
   *
   * The runtime half says why the rule exists at all. A colliding arm is published
   * verbatim, so a SETTLED act is indistinguishable on the reading from one still on
   * the wire — which is a surface reporting work in flight that has already finished.
   */
  it("refuses a settle callback whose arm reuses one of the three owned statuses", async () => {
    const colliding = new ActController<string, { readonly status: "sending" }>({
      label: "colliding settlement reading",
      clock: new ManualClock(),
      sessionStore: new SessionStore({ sessionId: "session-under-test" }),
      triggeringEventKinds: TRIGGERING_KINDS,
      refusalOrigin: TEST_ORIGIN,
      readPrerequisite: async () => ({ status: "served", value: "unused" }),
    });
    await colliding.act(
      async () => ({ status: "served", value: "settled" }),
      // @ts-expect-error the settle callback is typed `ActOwnArm<{ status: "sending" }>`,
      // which resolves to `never`, so no value of that shape is assignable.
      () => ({ status: "sending" as const }),
    );
    expect(colliding.snapshot.act.status).toBe("sending");
    colliding.dispose();
  });

  it("negative control: an arm with its own discriminant is admitted unchanged", async () => {
    const { controller } = open();
    const admitted: ActOwnArm<TestSettlement> = { status: "done", value: "kept" };
    await controller.act(
      async () => ({ status: "served", value: admitted.value }),
      (value) => ({ status: "done" as const, value }),
    );
    expect(controller.snapshot.act).toStrictEqual(admitted);
  });
});
