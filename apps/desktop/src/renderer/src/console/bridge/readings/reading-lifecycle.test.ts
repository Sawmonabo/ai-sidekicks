// The four transitions a reading's phase, refusal, and stream state make together.
//
// Driven against the real class rather than against a copy of its rules: every case
// below is one of the two readings' own call sequences, written out so the sequence
// can be read without a bridge, a clock, or React. What the readings then DO with
// these transitions is asserted where they are wired — `queue-feed.test.tsx` and
// `provider-quota-feed.test.tsx` — because a class that says "openable" and a reading
// that actually re-opens are two claims.

import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { WireReadLifecycle, readRefusalOf } from "./reading-lifecycle.js";

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

    // BOTH halves. The member is cleared, which is what makes `readRefusal` mean
    // "the newest read failed"; and the accessor derives the same answer from the
    // phase, so a later arm that forgot the clear still renders honestly.
    expect(lifecycle.state.readRefusal).toBeUndefined();
    expect(readRefusalOf(lifecycle.state)).toBeUndefined();
  });

  it("negative control: a refusal nothing has superseded is still carried", () => {
    // Without this the case above would pass over a class that never carried a
    // refusal at all, which renders a failed read as a node with nothing to report.
    const lifecycle = new WireReadLifecycle();
    lifecycle.markOpen();
    lifecycle.refuseRead(READ_REFUSED);

    expect(readRefusalOf(lifecycle.state)?.code).toBe("reply-unreadable");
  });

  it("renders nothing for a refusal stranded on a served phase", () => {
    // The accessor's own claim, stated over the shape it defends against: a state
    // whose phase says served and whose member still carries a refusal renders none.
    expect(readRefusalOf({ phase: "read", readRefusal: READ_REFUSED })).toBeUndefined();
    expect(readRefusalOf({ phase: "reading", readRefusal: READ_REFUSED })).toBeUndefined();
  });
});

describe("a refused open says whether trying again is worth anything", () => {
  it("leaves a transport failure re-openable", () => {
    const lifecycle = new WireReadLifecycle();
    lifecycle.refuseOpen(OPEN_REFUSED);

    expect(lifecycle.state.phase).toBe("refused");
    expect(lifecycle.isOpen).toBe(false);
    // The reading is closed rather than open, which is what makes a read guarded on
    // `isOpen` a no-op — and openable, which is what lets a trigger re-open it.
    expect(lifecycle.isOpenable).toBe(true);
  });

  it("closes the door on a request the registered shape refused", () => {
    const lifecycle = new WireReadLifecycle();
    lifecycle.refuseOpenTerminally(OPEN_REFUSED);

    expect(lifecycle.state.phase).toBe("refused");
    expect(lifecycle.isOpen).toBe(false);
    expect(lifecycle.isOpenable).toBe(false);
  });

  it("does not report an open tail while the reading is closed", () => {
    // The state that made a dead account-plane reading present itself as current: a
    // read served behind no tail. `isOpen` is the guard, so it has to be false on
    // every arm but the one where the subscription is genuinely in hand.
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

    // A refused snapshot is not a refused stream: the tail is still the authority
    // for what this reading holds, and re-opening it would blank what it delivered.
    expect(lifecycle.isOpen).toBe(true);
  });
});
