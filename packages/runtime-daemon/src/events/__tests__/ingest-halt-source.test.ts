// Regression coverage for `IngestHaltRegistry`'s TWO-MECHANISM concurrency fix
// (Plan-006 T3.1, F-006-HALT-07).
//
// WHY THIS FILE EXISTS, and what it is deliberately NOT. It is not general
// coverage of the halt seam — T3.5 owns that, and its arms are sequential
// halt/clear round-trips. This file pins the two mechanisms those arms cannot
// see, because both are invisible to any serial call order:
//
//   * `#pendingClears` — without it, a `halt()` racing a QUEUED `clear()`
//     no-ops on set membership before the lock and is then silently undone.
//   * `#haltGenerations` — without it, a REENTRANT `halt()` (the T4.2
//     observer's own shape: it already holds the session's append lock) runs
//     AHEAD of a clear that queued earlier and is then deleted by it.
//
// Both are fail-OPEN on a security gate: an `await halt(S)` that resolved
// successfully leaves S admitting writes. Delete either mechanism and every
// sequential arm in the suite stays green — which is precisely why these live
// here rather than being folded into a sequential describe block.
//
// Coverage map:
//   * Mechanism 1 — a queued `clear(S)` followed by `halt(S)` leaves S halted.
//   * Mechanism 2 — a reentrant `halt(S)` inside a held lock beats a `clear(S)`
//     queued behind that hold.
//   * Rest state — after the contended round the registry is unwedged AND the
//     pre-lock fast path is available again (the observable proof that no
//     `#pendingClears` entry was stranded).
//   * F-006-HALT-07 — a repeat `halt(S)` with no clear in flight resolves
//     WITHOUT acquiring, while a `clear(S)` in the same position blocks.
//
// FIXTURE PROPERTY THAT MAKES THE REENTRANT ARM DISCRIMINATING (read before
// editing it): the racing `clear()` must be issued from OUTSIDE the hold's
// `AsyncLocalStorage` scope. Issued from inside the critical section it is
// itself reentrant — it runs immediately, deletes, and never queues, so the arm
// passes against a registry with no generation counter at all.

import type { SessionId } from "@ai-sidekicks/contracts";
import { SessionIdSchema } from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IngestHaltRegistry } from "../ingest-halt-source.js";
import { __resetSessionAppendLocksForTest, withSessionAppendLock } from "../session-append-lock.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00");

let registry: IngestHaltRegistry;

beforeEach(() => {
  // A FRESH registry per case: the halted set, the pendency counters and the
  // generation counters are all instance state, and a shared instance would let
  // one case's generation leak into the next case's captures.
  registry = new IngestHaltRegistry();
  // The append lock is a module SINGLETON, so it does not reset with the
  // registry. A case that leaves a queue entry behind would otherwise surface as
  // an unrelated timeout in the next one.
  __resetSessionAppendLocksForTest();
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
});

/** One macrotask — later than every pending microtask, so "has the hold landed
 * yet?" is never a question of await-counting. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface ParkedHold {
  /** Settles when the parked critical section has released the lock. */
  readonly settled: Promise<void>;
  /** Lets the critical section finish, releasing the lock. */
  release(): void;
}

/**
 * Take and PARK the session's append lock, so anything issued afterwards from
 * outside this hold's async context queues behind it.
 *
 * This stands in for the real hazard — a production append parked in a
 * signing-key unseal that may await a WebAuthn ceremony — without dragging a
 * database and a sealer into a test about two in-memory maps. What matters is
 * only that the lock is held across an await boundary for an unbounded time.
 */
async function parkSessionLock(sessionId: SessionId): Promise<ParkedHold> {
  let release!: () => void;
  const parked: Promise<void> = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settled: Promise<void> = withSessionAppendLock(sessionId, async () => {
    await parked;
  });
  // The acquire path awaits its predecessor before running `critical`, so the
  // hold is not live on return from the call — wait for it to actually land.
  await tick();
  return { settled, release };
}

/**
 * Did `work` settle WITHOUT waiting for the lock?
 *
 * This is how the fast-path property is observed without reaching into privates:
 * a call that takes the pre-lock path resolves while a hold is still live, and a
 * call that acquires cannot.
 *
 * The race is against a MACROTASK BOUNDARY, not a wall-clock budget, and that
 * distinction is the whole robustness argument. The fast path resolves in a
 * microtask, and the microtask queue always drains before the next timer
 * callback runs — regardless of how long the loop was starved or how long a GC
 * pause held it. So "resolved" wins deterministically, where any millisecond
 * budget would only win probabilistically. The blocked direction cannot
 * false-positive either: an acquiring call waits on a hold that nothing can
 * release until the test body calls `release()`, so it is still pending at every
 * macrotask boundary until then.
 */
async function settlesWithoutAcquiring(work: Promise<void>): Promise<"resolved" | "blocked"> {
  const blocked: Promise<"blocked"> = tick().then((): "blocked" => "blocked");
  return Promise.race([work.then((): "resolved" => "resolved"), blocked]);
}

// ----------------------------------------------------------------------------
// Mechanism 1 — `#pendingClears` makes the pre-lock fast path safe to take
// ----------------------------------------------------------------------------

describe("IngestHaltRegistry — halt racing a QUEUED clear (Mechanism 1, #pendingClears)", () => {
  it("leaves the session halted when halt() is issued while a clear() is queued behind a parked lock", async () => {
    await registry.halt(SESSION);
    const hold: ParkedHold = await parkSessionLock(SESSION);

    // The clear queues: the lock is held by someone else and this call is
    // outside that holder's async context.
    const clearing: Promise<void> = registry.clear(SESSION);

    // Issued SYNCHRONOUSLY after `clear`, with no intervening tick — that is
    // deliberate. It pins the ordering requirement that `clear` publishes its
    // pendency BEFORE its first `await`: were the increment moved after the
    // await, this `halt` would find a pendency of 0, take the fast path on
    // membership alone, and be undone by the clear that runs later.
    const halting: Promise<void> = registry.halt(SESSION);

    hold.release();
    await Promise.all([hold.settled, clearing, halting]);

    // The halt's caller was told the session was halted. It must be halted.
    // Without `#pendingClears` the clear's delete is the last write and this is
    // `false` — an `await halt()` that resolved successfully onto a session that
    // admits writes.
    expect(registry.isHalted(SESSION)).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Mechanism 2 — `#haltGenerations` makes a REENTRANT halt stick
// ----------------------------------------------------------------------------

describe("IngestHaltRegistry — reentrant halt vs a queued clear (Mechanism 2, #haltGenerations)", () => {
  it("keeps the session halted when a lock-holding caller halts reentrantly while a clear waits behind its hold", async () => {
    await registry.halt(SESSION);

    // The T4.2 observer's shape: it holds the session's append lock across an
    // await and publishes its halt from INSIDE that critical section, where the
    // acquisition is reentrant and therefore does not queue.
    let release!: () => void;
    const parked: Promise<void> = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observerHold: Promise<void> = withSessionAppendLock(SESSION, async () => {
      await parked;
      await registry.halt(SESSION);
    });
    await tick();

    // ISSUED FROM THE TEST BODY, outside the hold's AsyncLocalStorage scope, so
    // it genuinely queues. See the file header: issuing it inside the critical
    // section makes this arm pass against a registry with no generation counter.
    const clearing: Promise<void> = registry.clear(SESSION);

    release();
    await Promise.all([observerHold, clearing]);

    // FIFO says the clear runs after the observer releases, i.e. AFTER the
    // reentrant halt already re-added the session — so ordering alone would let
    // the clear win. The generation the reentrant halt bumped is what makes the
    // clear skip its delete instead.
    expect(registry.isHalted(SESSION)).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Rest state — the contended round leaves nothing stranded
// ----------------------------------------------------------------------------

describe("IngestHaltRegistry — returns to rest state after a contended round", () => {
  it("stays clearable and keeps the fast path available, proving no pendency was stranded", async () => {
    await registry.halt(SESSION);

    const hold: ParkedHold = await parkSessionLock(SESSION);
    const clearing: Promise<void> = registry.clear(SESSION);
    const halting: Promise<void> = registry.halt(SESSION);
    hold.release();
    await Promise.all([hold.settled, clearing, halting]);
    expect(registry.isHalted(SESSION)).toBe(true);

    // NOT WEDGED: a plain serial clear still re-admits. A generation left
    // permanently ahead of every future capture would make this stick at `true`.
    await registry.clear(SESSION);
    expect(registry.isHalted(SESSION)).toBe(false);

    // And a full round-trip still behaves.
    await registry.halt(SESSION);
    expect(registry.isHalted(SESSION)).toBe(true);

    // THE OBSERVABLE DRAIN ASSERTION. A `#pendingClears` entry stranded by the
    // contended round would force every later `halt()` for this session onto the
    // lock forever — a silent, permanent loss of the F-006-HALT-07 property
    // rather than a wrong answer. Reaching for the private map would test the
    // implementation; parking the lock tests the consequence.
    const blockingHold: ParkedHold = await parkSessionLock(SESSION);
    expect(await settlesWithoutAcquiring(registry.halt(SESSION))).toBe("resolved");
    blockingHold.release();
    await blockingHold.settled;
  });
});

// ----------------------------------------------------------------------------
// F-006-HALT-07 — the pre-lock fast path survives the fix
// ----------------------------------------------------------------------------

describe("IngestHaltRegistry — F-006-HALT-07 (a repeat halt never queues behind a parked append)", () => {
  it("resolves a repeat halt under a live hold, while a clear in the same position blocks", async () => {
    await registry.halt(SESSION);
    const hold: ParkedHold = await parkSessionLock(SESSION);

    // The reconciler tick's common case: re-issuing `halt` for a session still
    // in the collision set, with no clear in flight. It must not serialize
    // behind an append that may be parked on a human ceremony.
    expect(await settlesWithoutAcquiring(registry.halt(SESSION))).toBe("resolved");

    // The built-in negative control for the assertion above: "resolves under a
    // hold" is NOT vacuously true of every registry write. `clear` decides its
    // no-op AFTER acquisition by design, so in the identical position it blocks.
    // Without this pairing, an arm that resolved because the lock was somehow
    // free would read as a passing fast-path test.
    const clearing: Promise<void> = registry.clear(SESSION);
    expect(await settlesWithoutAcquiring(clearing)).toBe("blocked");

    hold.release();
    await Promise.all([hold.settled, clearing]);

    // The clear captured its generation before any of this and nothing bumped
    // it — the repeat halt took the FAST path, which never reaches the bump — so
    // the clear's delete stands.
    expect(registry.isHalted(SESSION)).toBe(false);
  });
});
