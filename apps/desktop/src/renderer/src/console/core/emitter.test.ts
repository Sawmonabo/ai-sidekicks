// The emitter, driven at the two points where the naive version is wrong.
//
// Anyone can write subscribe / emit / unsubscribe over a `Set` in four lines. The
// reason this one is a module rather than four lines per family is the two
// behaviours its header calls decisions, and both are invisible until the day they
// matter: mutating a `Set` while iterating it is DEFINED in JavaScript, so an
// unsubscribe during emission silently skips a sink that was still subscribed; and
// a throwing sink swallowed or propagated early makes delivery depend on
// subscription order. Those two are the cases below, and they are why the rest of
// the file exists at all.

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
      // A real shape, not a contrivance: a first sink that tears down a pane
      // detaches the second sink that pane owned, and it does so during delivery.
      unsubscribeSecond();
    });
    unsubscribeSecond = emitter.subscribe((event) => received.push(event));

    emitter.emit("first");

    // Subscribed when this emission began, so it receives this one. Iterating the
    // live `Set` would have skipped it — quietly, and only for sinks that happened
    // to sit after the unsubscriber.
    expect(received).toStrictEqual(["first"]);
  });

  it("negative control: the same sink misses the NEXT event, so the unsubscribe was real", () => {
    // Without this, a `subscribe` that returned a function doing nothing would pass
    // the case above, and the snapshot claim would be untested.
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

    // The middle sink ran even though the one before it threw: letting the first
    // throw propagate would make delivery depend on subscription order.
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
    // A lone failure wrapped in an `AggregateError` would make every existing
    // `catch (error) { if (error instanceof TypeError) }` at a subscriber's own
    // boundary stop matching.
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
    // Without this, an `emit` that threw unconditionally would satisfy all three
    // cases above.
    const emitter = new Emitter<string>("scenario frame");
    emitter.subscribe(() => undefined);

    expect(() => {
      emitter.emit("tick");
    }).not.toThrow();
  });
});
