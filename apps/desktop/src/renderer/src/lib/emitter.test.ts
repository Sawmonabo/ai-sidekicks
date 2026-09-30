// The two points where a naive emitter is wrong: mutating a `Set` while iterating it is defined
// in JavaScript, so an unsubscribe during emission silently skips a sink, and a throwing sink
// swallowed or propagated early makes delivery depend on subscription order.

import { describe, expect, it } from "vitest";
import { Emitter } from "./emitter.js";

describe("Emitter — delivery", () => {
  it("delivers to every subscribed sink, in subscription order", () => {
    const emitter = new Emitter<string>("scenario frame");
    const received: string[] = [];
    emitter.subscribe((event) => received.push(`first:${event}`));
    emitter.subscribe((event) => received.push(`second:${event}`));

    emitter.emit("tick");

    expect(received).toStrictEqual(["first:tick", "second:tick"]);
  });

  it("counts its sinks, and stops counting one that unsubscribed", () => {
    const emitter = new Emitter<string>("scenario frame");
    const unsubscribe = emitter.subscribe(() => undefined);
    expect(emitter.sinkCount).toBe(1);

    unsubscribe();

    expect(emitter.sinkCount).toBe(0);
  });

  it("treats a second unsubscribe as a no-op rather than an error", () => {
    const emitter = new Emitter<string>("scenario frame");
    const unsubscribe = emitter.subscribe(() => undefined);
    unsubscribe();

    expect(() => {
      unsubscribe();
    }).not.toThrow();
    expect(emitter.sinkCount).toBe(0);
  });

  it("delivers nothing after clear, and does not throw doing it", () => {
    const emitter = new Emitter<string>("scenario frame");
    const received: string[] = [];
    emitter.subscribe((event) => received.push(event));

    emitter.clear();
    emitter.emit("tick");

    expect(emitter.sinkCount).toBe(0);
    expect(received).toStrictEqual([]);
  });
});

describe("Emitter — emission iterates a snapshot", () => {
  it("still delivers this event to a sink another sink unsubscribed mid-emission", () => {
    const emitter = new Emitter<string>("scenario frame");
    const received: string[] = [];
    let unsubscribeSecond = (): void => undefined;
    emitter.subscribe(() => {
      // A first sink that tears down a pane detaches the second sink that pane owned.
      unsubscribeSecond();
    });
    unsubscribeSecond = emitter.subscribe((event) => received.push(event));

    emitter.emit("first");

    // Subscribed when this emission began, so it receives this one; a live `Set` would skip it.
    expect(received).toStrictEqual(["first"]);
  });

  it("negative control: the same sink misses the NEXT event, so the unsubscribe was real", () => {
    // Guards against an unsubscribe that does nothing passing the case above.
    const emitter = new Emitter<string>("scenario frame");
    const received: string[] = [];
    let unsubscribeSecond = (): void => undefined;
    emitter.subscribe(() => {
      unsubscribeSecond();
    });
    unsubscribeSecond = emitter.subscribe((event) => received.push(event));

    emitter.emit("first");
    emitter.emit("second");

    expect(received).toStrictEqual(["first"]);
    expect(emitter.sinkCount).toBe(1);
  });
});

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

  it("names the stream in the aggregate message", () => {
    const emitter = new Emitter<string>("tripwire report");
    emitter.subscribe(() => {
      throw new Error("broken");
    });
    emitter.subscribe(() => {
      throw new Error("also broken");
    });

    expect(() => {
      emitter.emit("bridge-shape-drift");
    }).toThrow(/2 sinks failed while receiving a tripwire report/);
  });

  it("re-raises a single failure as itself rather than wrapping it", () => {
    // Wrapping a lone failure would break `instanceof` checks at a subscriber's own boundary.
    const emitter = new Emitter<string>("scenario frame");
    const only = new TypeError("the sink is broken");
    emitter.subscribe(() => {
      throw only;
    });

    expect(() => {
      emitter.emit("tick");
    }).toThrow(only);
  });

  it("negative control: an emission whose sinks all succeed throws nothing", () => {
    // Guards against an `emit` that always throws satisfying the cases above.
    const emitter = new Emitter<string>("scenario frame");
    emitter.subscribe(() => undefined);

    expect(() => {
      emitter.emit("tick");
    }).not.toThrow();
  });
});
