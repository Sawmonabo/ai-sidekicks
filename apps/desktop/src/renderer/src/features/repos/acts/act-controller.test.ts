// The act primitive's two halves, driven through every arm each publishes. Real classes,
// scheduler and latch; only the wire call is the test's, so cases can hold answers open and
// settle them out of order (two presses in one tick, a clear while a call is on the wire).

import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { ActController, PrerequisiteReader } from "./act-controller.js";
import { flush, runScheduledRead } from "./act-controller.test-support.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

/** The frames this reading would re-read on. Never fired here; declared to be read. */
const TRIGGERING_KINDS: ReadonlySet<string> = new Set(["workspace.ready"]);

interface TestSettlement {
  readonly status: "done";
  readonly value: string;
}

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

interface OpenedReader {
  readonly reader: PrerequisiteReader<string>;
  readonly clock: ManualClock;
  readonly questionsAsked: string[];
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
    // The answer already on screen is untouched, not blanked.
    expect(reader.snapshot.status).toBe("read");
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

  it("a rejected send publishes the refusal with the service's own message", async () => {
    const controller = openActs();
    await controller.act(
      async () => await Promise.reject(new Error("the wire failed")),
      (value: string) => ({ status: "done" as const, value }),
    );
    const refused = controller.snapshot;
    expect(refused.status).toBe("refused");
    expect(refused.status === "refused" && refused.refusal.detail).toBe("the wire failed");
  });

  it("sends nothing for a second act in the same tick", async () => {
    const controller = openActs();
    const answer = heldAnswer<string>();
    const secondSend = vi.fn();
    const first = controller.act(
      async () => await answer.promise,
      (value) => ({ status: "done" as const, value }),
    );
    // Two presses inside one frame both read an idle dialog; the key is what refuses.
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

  it(
    "clearing the settlement keeps the key, so a call still in " + "flight is not doubled",
    async () => {
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
    },
  );
});
