// The act primitive, driven through every arm it publishes. The real class and latch; only the
// wire call is the test's, so cases can hold answers open and settle them out of order (two
// presses in one tick, a clear while a call is on the wire).

import { describe, expect, it, vi } from "vitest";

import { ActController } from "./act-controller.js";

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

function openActs(): ActController<TestSettlement> {
  return new ActController<TestSettlement>({ label: "act controller test reading" });
}

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

  it("clearing the settlement keeps the key, so a call in flight is not doubled", async () => {
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
});
