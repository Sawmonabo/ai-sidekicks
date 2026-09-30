// The transitions a reading's phase, refusal and stream state make together, driven against the
// real class as a reading's own call sequence, without a bridge, clock or React. What a reading
// does with them is asserted where it is wired.

import { describe, expect, it } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";
import { WireReadLifecycle, findReadRefusal } from "./read-lifecycle.js";

const READ_REFUSED = refuse("session-queue", "reply-unreadable", "The reply did not parse.");
const OPEN_REFUSED = refuse("console-daemon-stream", "stream-unavailable", "The daemon is a stub.");

describe("a served read clears the refusal that preceded it", () => {
  it("leaves no refusal behind once a later read serves", () => {
    const lifecycle = new WireReadLifecycle();
    lifecycle.markOpen();
    lifecycle.refuseRead(READ_REFUSED);
    expect(lifecycle.state.phase).toBe("refused");
    expect(lifecycle.state.readRefusal?.code).toBe("reply-unreadable");

    lifecycle.settleRead();

    // Both halves: the member is cleared, which makes `readRefusal` mean "the newest read failed",
    // and the accessor derives the same answer from the phase.
    expect(lifecycle.state.readRefusal).toBeUndefined();
    expect(findReadRefusal(lifecycle.state)).toBeUndefined();
  });

  it("negative control: a refusal nothing has superseded is still carried", () => {
    // Without this the case above would pass over a class that never carried a refusal at all.
    const lifecycle = new WireReadLifecycle();
    lifecycle.markOpen();
    lifecycle.refuseRead(READ_REFUSED);

    expect(findReadRefusal(lifecycle.state)?.code).toBe("reply-unreadable");
  });

  it("renders nothing for a refusal stranded on a served phase", () => {
    // The accessor's own claim: a state whose phase says served renders no refusal even if the
    // member still carries one.
    expect(findReadRefusal({ phase: "read", readRefusal: READ_REFUSED })).toBeUndefined();
    expect(findReadRefusal({ phase: "reading", readRefusal: READ_REFUSED })).toBeUndefined();
  });
});

describe("a refused open says whether trying again is worth anything", () => {
  it("leaves a transport failure re-openable", () => {
    const lifecycle = new WireReadLifecycle();
    lifecycle.refuseOpen(OPEN_REFUSED);

    expect(lifecycle.state.phase).toBe("refused");
    expect(lifecycle.isOpen).toBe(false);
    // Closed, so a read guarded on `isOpen` is a no-op; openable, so a trigger can re-open it.
    expect(lifecycle.isOpenable).toBe(true);
  });

  it("never re-opens after a request the registered shape refused", () => {
    const lifecycle = new WireReadLifecycle();
    lifecycle.refuseOpenTerminally(OPEN_REFUSED);

    expect(lifecycle.state.phase).toBe("refused");
    expect(lifecycle.isOpen).toBe(false);
    expect(lifecycle.isOpenable).toBe(false);
  });

  it("does not report an open tail while the reading is closed", () => {
    // A read served behind no tail is what made a dead reading present itself as current, so
    // `isOpen` must be false on every arm but the one where the subscription is in hand.
    const lifecycle = new WireReadLifecycle();
    expect(lifecycle.isOpen).toBe(false);

    lifecycle.markOpen();
    expect(lifecycle.isOpen).toBe(true);
    expect(lifecycle.isOpenable).toBe(false);

    lifecycle.markClosed();
    expect(lifecycle.isOpen).toBe(false);
    expect(lifecycle.isOpenable).toBe(true);
  });

  it("leaves the tail alone when only the read refused", () => {
    const lifecycle = new WireReadLifecycle();
    lifecycle.markOpen();
    lifecycle.refuseRead(READ_REFUSED);

    // A refused snapshot is not a refused stream: the tail is still the authority for what this
    // reading holds, and re-opening it would blank what it delivered.
    expect(lifecycle.isOpen).toBe(true);
  });
});
