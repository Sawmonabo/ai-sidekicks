// The scheduled-reading base, driven through a concrete subclass on frozen time.
//
// A BASE IS TESTED THROUGH A SUBCLASS BECAUSE THAT IS ITS ONLY CALLER. Every member
// under test is `protected` or is reached by the scheduler the constructor built, so a
// case that reached in would be testing a shape no reading can write. The probe below
// is the smallest reading that compiles — a revisioned snapshot, a supplied read, and
// the two refusal-arm sentences a real reading spells for itself — and every claim is
// made about the REAL `ScheduledReading`, never about a stand-in.
//
// It runs on `ManualClock` and arms no real timer, on `refresh-scheduler.test.ts`'s
// reason: `clock.pendingCount === 0` after a dispose is the only way "the
// scheduler stopped" can be CHECKED rather than asserted.

import { describe, expect, it } from "vitest";

import { lossyStringify, ManualClock } from "../../core/index.js";
import type { GenerationClaim } from "./generation-latch.js";
import { NO_TRIGGERING_EVENT_KINDS } from "./read-triggers.js";
import { ScheduledReading } from "./scheduled-reading.js";
import { settleMicrotasks } from "../session-store-registry.test-support.js";

/** Past the trailing debounce, so one `advance` settles a read. */
const PAST_DEBOUNCE_MS = 200;

/** What the probe publishes: the three arms a real reading holds, plus its counter. */
interface ProbeSnapshot {
  readonly reading: { readonly kind: "answered"; readonly value: string } | undefined;
  readonly refusal: string | undefined;
  readonly revision: number;
}

const NOTHING_READ: ProbeSnapshot = { reading: undefined, refusal: undefined, revision: 0 };

interface ProbeOptions {
  readonly clock: ManualClock;
  /** What one read answers. Throwing is the arm a real port's rejection reaches. */
  readonly read: () => Promise<string>;
  /** Whether this probe has a subject to read for at all. */
  readonly isReadable?: boolean;
  /** Whether each read supersedes the one before it, as three real readings do. */
  readonly supersedes?: boolean;
  /**
   * Whether this probe's PUBLISH throws — the one defect the base's failure arm is for.
   *
   * A rejecting `read` is settled inside `performRead` as the refusal arm, which is the
   * contract. A fold that throws escapes `performRead` itself, which is what reaches the
   * scheduler's `onError` and what used to vanish there.
   */
  readonly publishThrows?: boolean;
  /** The owner's diagnostics sink, as a real reading's holder wires it. */
  readonly onReadError?: (error: unknown) => void;
}

/**
 * The smallest reading the base admits.
 *
 * `CostReceiptRead`'s shape with the bridge taken out: a revisioned fold over
 * `publish`, a `performRead` that settles both arms through a round, and the readable
 * guard. Nothing here is a reimplementation of the base — every member it uses is
 * called on `super`.
 */
class ProbeReading extends ScheduledReading<ProbeSnapshot> {
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  /** Every read this probe entered, so a suppressed publish is separable from none. */
  public readonly readsEntered: string[] = [];
  readonly #read: () => Promise<string>;
  readonly #supersedes: boolean;
  readonly #publishThrows: boolean;
  /** Mutable, because a subject ARRIVING is what a settings address does mid-mount. */
  #isReadable: boolean;

  public constructor(options: ProbeOptions) {
    super({
      clock: options.clock,
      initialSnapshot: NOTHING_READ,
      describeChange: "probe read",
      ...(options.onReadError === undefined ? {} : { onReadError: options.onReadError }),
    });
    this.#read = options.read;
    this.#isReadable = options.isReadable ?? true;
    this.#supersedes = options.supersedes ?? false;
    this.#publishThrows = options.publishThrows ?? false;
  }

  /** The out-of-band supersede three real readings perform after a write. */
  public supersedeInFlightRead(): void {
    this.supersedeAndClaimReadRound().release();
  }

  /**
   * The out-of-band act that HOLDS the key: a write this reading itself started.
   *
   * The case `currentReadRound` exists for. The claim is kept — not released — so a
   * read taken while it is outstanding either joins that round or revokes it, which is
   * the whole difference between the two round-taking members.
   */
  public beginOutOfBandWrite(): GenerationClaim {
    return this.supersedeAndClaimReadRound();
  }

  /** The subject arriving after the mount — a settings address that gained a session. */
  public becomeReadable(): void {
    this.#isReadable = true;
  }

  protected override isReadable(): boolean {
    return this.#isReadable;
  }

  protected override async performRead(): Promise<void> {
    this.readsEntered.push("entered");
    const round = this.#supersedes ? this.supersedeAndClaimReadRound() : this.currentReadRound();
    try {
      const value = await this.#read();
      round.settle(() => {
        this.#publishChanges({ reading: { kind: "answered", value } });
      });
    } catch (rejection: unknown) {
      if (this.#publishThrows) {
        // A fold that cannot build a snapshot cannot build the REFUSAL snapshot
        // either, so a reading in this state has nowhere of its own left to put the
        // defect and it escapes `performRead` — the one path that reaches the
        // scheduler's failure arm, and the one the base owes a count and a sink.
        throw rejection;
      }
      round.settle(() => {
        // Through the console's total stringifier, never `String(rejection)`: a caught
        // value has nothing established about it, and this probe is held to the same
        // rule the readings it stands in for are.
        this.#publishChanges({ refusal: lossyStringify(rejection) });
      });
    }
  }

  #publishChanges(changes: Partial<Omit<ProbeSnapshot, "revision">>): void {
    if (this.#publishThrows) {
      throw new Error("the fold could not build a snapshot");
    }
    const current = this.snapshot();
    this.publish({ ...current, ...changes, revision: current.revision + 1 });
  }
}

describe("ScheduledReading — a scheduled read published to subscribers", () => {
  it("schedules, reads, and hands every subscriber the revisioned snapshot", async () => {
    const clock = new ManualClock(0);
    const reading = new ProbeReading({ clock, read: () => Promise.resolve("served") });
    const heard: ProbeSnapshot[] = [];
    reading.subscribe(() => {
      heard.push(reading.snapshot());
    });

    // Before anything is asked, the seed is what a surface renders — and no timer is
    // armed, so a reading nobody started costs the idle window nothing.
    expect(reading.snapshot()).toStrictEqual(NOTHING_READ);
    expect(clock.pendingCount).toBe(0);

    reading.start();
    expect(reading.performCount).toBe(0);
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();

    expect(reading.performCount).toBe(1);
    expect(reading.snapshot()).toStrictEqual({
      reading: { kind: "answered", value: "served" },
      refusal: undefined,
      revision: 1,
    });
    // The subscriber heard the same identity the accessor answers with, which is what
    // `useSyncExternalStore` compares — one emission, not one per member changed.
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBe(reading.snapshot());
  });

  it("starts once however many times a strict-mode effect mounts it", async () => {
    const clock = new ManualClock(0);
    const reading = new ProbeReading({ clock, read: () => Promise.resolve("served") });

    reading.start();
    reading.start();
    reading.start();
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();

    expect(reading.performCount).toBe(1);
    expect(reading.snapshot().revision).toBe(1);
  });

  it("publishes nothing from a read a newer generation superseded", async () => {
    const clock = new ManualClock(0);
    let releaseRead: ((value: string) => void) | undefined;
    const reading = new ProbeReading({
      clock,
      read: () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
    });

    reading.requestRead("subscribe");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();
    expect(reading.readsEntered).toHaveLength(1);

    // The act a real reading performs after a write: whatever read is outstanding is
    // answering a question that has since been re-asked.
    reading.supersedeInFlightRead();
    releaseRead?.("stale");
    await settleMicrotasks();

    // The read ran and its reply landed. What it did NOT do is install — which is the
    // whole difference between a superseded read and one that never happened.
    expect(reading.readsEntered).toHaveLength(1);
    expect(reading.snapshot()).toStrictEqual(NOTHING_READ);
  });

  it("negative control: the same reply installs when nothing superseded it", async () => {
    // The same script with the supersede removed, so the case above is a claim about
    // the round rather than about the deferred promise it was driven with.
    const clock = new ManualClock(0);
    let releaseRead: ((value: string) => void) | undefined;
    const reading = new ProbeReading({
      clock,
      read: () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
    });

    reading.requestRead("subscribe");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();
    releaseRead?.("stale");
    await settleMicrotasks();

    expect(reading.snapshot().reading).toStrictEqual({ kind: "answered", value: "stale" });
  });

  it("settles a synchronous throw in the read as the refusal arm", async () => {
    const clock = new ManualClock(0);
    const reading = new ProbeReading({
      clock,
      read: () => {
        throw new Error("the port did not answer");
      },
    });

    reading.requestRead("user-request");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();

    // Published rather than swallowed: a surface renders the refusal instead of
    // reporting a read that failed as one still in flight. And nothing was re-thrown
    // into the timer callback, which the clock having no pending work attests.
    expect(reading.snapshot()).toStrictEqual({
      reading: undefined,
      refusal: "Error: the port did not answer",
      revision: 1,
    });
    expect(reading.performCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("counts a read whose fold threw, tells the sink, and keeps rendering the last snapshot", async () => {
    const clock = new ManualClock(0);
    const reported: unknown[] = [];
    const reading = new ProbeReading({
      clock,
      publishThrows: true,
      onReadError: (error) => {
        reported.push(error);
      },
      read: () => Promise.reject(new Error("the port did not answer")),
    });

    reading.requestRead("user-request");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();

    // The defect is COUNTED and REPORTED rather than swallowed. A base that answered
    // the scheduler with `() => undefined` left a reading frozen at its previous
    // snapshot with nothing on screen and nothing in diagnostics saying why.
    expect(reading.failedReadCount).toBe(1);
    expect(reported).toHaveLength(1);
    expect(lossyStringify(reported[0])).toBe("Error: the port did not answer");
    // And the read still ran, the snapshot still stands, and nothing was re-thrown
    // into the timer callback — which the clock holding no pending work attests.
    expect(reading.readsEntered).toHaveLength(1);
    expect(reading.performCount).toBe(1);
    expect(reading.snapshot()).toStrictEqual(NOTHING_READ);
    expect(clock.pendingCount).toBe(0);
  });

  it("negative control: a read whose fold holds counts no failure and tells no sink", async () => {
    // The same script with the throwing fold removed, so the case above is a claim
    // about the failure arm rather than about any read that mentions a rejection.
    const clock = new ManualClock(0);
    const reported: unknown[] = [];
    const reading = new ProbeReading({
      clock,
      onReadError: (error) => {
        reported.push(error);
      },
      read: () => Promise.reject(new Error("the port did not answer")),
    });

    reading.requestRead("user-request");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();

    expect(reading.failedReadCount).toBe(0);
    expect(reported).toStrictEqual([]);
    expect(reading.snapshot().refusal).toBe("Error: the port did not answer");
  });

  it("counts a failed read with no sink wired, so an absent hook is not silence", async () => {
    const clock = new ManualClock(0);
    const reading = new ProbeReading({
      clock,
      publishThrows: true,
      read: () => Promise.reject(new Error("the port did not answer")),
    });

    reading.requestRead("user-request");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();

    expect(reading.failedReadCount).toBe(1);
  });

  it("spends the one shot on admission, so a start with no subject does not consume it", async () => {
    const clock = new ManualClock(0);
    const reading = new ProbeReading({
      clock,
      isReadable: false,
      read: () => Promise.resolve("served"),
    });

    // A mount that arrives before the subject does. The reason is refused, and the
    // one-shot latch must be refused with it — latching first left the reading unable
    // to ever read, because every later `start()` was answered by the flag.
    reading.start();
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();
    expect(reading.performCount).toBe(0);

    reading.becomeReadable();
    reading.start();
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();

    expect(reading.performCount).toBe(1);
    expect(reading.snapshot().reading).toStrictEqual({ kind: "answered", value: "served" });
  });

  it("stops the scheduler and releases the latch on dispose", async () => {
    const clock = new ManualClock(0);
    let releaseRead: ((value: string) => void) | undefined;
    const reading = new ProbeReading({
      clock,
      read: () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
    });

    reading.requestRead("subscribe");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();

    reading.dispose();
    expect(reading.isDisposed).toBe(true);
    // The latch went with it: the reply of the read that was in flight when the page
    // went away finds no key naming its serial and installs nothing.
    releaseRead?.("landed after the page went away");
    await settleMicrotasks();
    expect(reading.snapshot()).toStrictEqual(NOTHING_READ);

    // And nothing is armed afterwards. A reason raised after disposal is dropped at
    // the guard, so the pane that unmounted keeps no timer alive behind it.
    reading.requestRead("window-focus");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();
    expect(clock.pendingCount).toBe(0);
    expect(reading.performCount).toBe(1);
  });

  it("asks nothing at all while it has no subject to read for", async () => {
    const clock = new ManualClock(0);
    const reading = new ProbeReading({
      clock,
      isReadable: false,
      read: () => Promise.resolve("served"),
    });

    reading.start();
    reading.requestRead("window-focus");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();

    // Refused at the guard rather than inside the read, so an unreadable reading never
    // arms the scheduler — the property the idle-window budget rests on.
    expect(clock.pendingCount).toBe(0);
    expect(reading.readsEntered).toStrictEqual([]);
    expect(reading.performCount).toBe(0);
    expect(reading.snapshot()).toStrictEqual(NOTHING_READ);
  });

  it.each([
    // The two modes on ONE script, and the expectation is the whole difference between
    // them. Two reads in sequence cannot separate them — the scheduler serializes, so
    // the second read is opened after the first has settled and both modes install it
    // — which is what the case here used to assert, with the flag flipped changing
    // nothing. What separates them is a key an OUT-OF-BAND act is holding: a
    // mint-and-settle read JOINS that write's round and leaves it live, and a
    // supersede-and-claim read revokes it.
    ["mints and settles inside the write's round", false, true],
    ["takes the key, abandoning the write's round", true, false],
  ] as const)(
    "%s where a reading declares that rule",
    async (_rule, supersedes, writeStillSettles) => {
      const clock = new ManualClock(0);
      let releaseRead: ((value: string) => void) | undefined;
      const reading = new ProbeReading({
        clock,
        supersedes,
        read: () =>
          new Promise<string>((resolve) => {
            releaseRead = resolve;
          }),
      });

      // The act a real reading performs around a durable write: the key is taken and
      // HELD until that write settles, so the read below overlaps it.
      const write = reading.beginOutOfBandWrite();

      reading.requestRead("user-request");
      clock.advance(PAST_DEBOUNCE_MS);
      await settleMicrotasks();
      expect(reading.readsEntered).toHaveLength(1);
      releaseRead?.("read answer");
      await settleMicrotasks();

      // Both modes install the read itself, which is why the reply alone can never
      // tell them apart.
      expect(reading.snapshot().reading).toStrictEqual({ kind: "answered", value: "read answer" });

      // And then the write settles. Whether its settlement still installs is the rule
      // the reading declared: `currentReadRound` promised not to revoke a key an
      // out-of-band act is holding, and `supersedeAndClaimReadRound` promised the
      // newest read wins.
      const writeSettlements: string[] = [];
      const settled = write.settle(() => {
        writeSettlements.push("write settled");
      });
      expect(settled).toBe(writeStillSettles);
      expect(writeSettlements).toHaveLength(writeStillSettles ? 1 : 0);
    },
  );
});
