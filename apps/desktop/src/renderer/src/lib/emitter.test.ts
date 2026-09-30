// A throwing sink swallowed or propagated early makes delivery depend on subscription order.

import { describe, expect, it } from "vitest";
import { Emitter } from "./emitter.js";

describe("Emitter — a throwing sink does not silence the others", () => {
  it("runs every sink and raises the failures together", () => {
    const emitter = new Emitter<string>("tripwire report");
    const received: string[] = [];
    emitter.subscribe(() => {
      throw new Error("first sink is broken");
    });
    emitter.subscribe((event) => received.push(event));
    emitter.subscribe(() => {
      throw new Error("third sink is broken");
    });

    let raised: unknown;
    try {
      emitter.emit("bridge-shape-drift");
    } catch (emitFailure: unknown) {
      raised = emitFailure;
    }

    // The middle sink ran although the one before it threw.
    expect(received).toStrictEqual(["bridge-shape-drift"]);
    expect(raised).toBeInstanceOf(AggregateError);
    expect((raised as AggregateError).errors).toHaveLength(2);
  });
});
