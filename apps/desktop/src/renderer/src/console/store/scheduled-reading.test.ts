// The scheduled-reading base, driven through a concrete subclass on frozen time.
//
// A BASE IS TESTED THROUGH A SUBCLASS BECAUSE THAT IS ITS ONLY CALLER. Every member
// under test is `protected` or is reached by the scheduler the constructor built, so a
// case that reached in would be testing a shape no reading can write. The probe below
// is the smallest reading that compiles — a revisioned snapshot, a supplied read, and
// the two refusal-arm sentences a real reading spells for itself — and every claim is
// made about the REAL `ScheduledReading`, never about a stand-in.
//
// It runs on `ManualClock` and arms no real timer, on `scheduling.refresh-scheduler.
// test.ts`'s reason: `clock.pendingCount === 0` after a dispose is the only way "the
// scheduler stopped" can be CHECKED rather than asserted.

import { describe, expect, it } from "vitest";

import { lossyStringify, ManualClock } from "../core/index.js";
import { NO_TRIGGERING_EVENT_KINDS } from "./read-triggers.js";
import { ScheduledReading } from "./scheduled-reading.js";
import { settleMicrotasks } from "./session-store-registry.test-support.js";

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
  readonly #isReadable: boolean;
  readonly #supersedes: boolean;

  public constructor(options: ProbeOptions) {
    super({ clock: options.clock, initialSnapshot: NOTHING_READ, describeChange: "probe read" });
    this.#read = options.read;
    this.#isReadable = options.isReadable ?? true;
    this.#supersedes = options.supersedes ?? false;
  }

  /** The out-of-band supersede three real readings perform after a write. */
  public supersedeInFlightRead(): void {
    this.supersedeAndClaimReadRound().release();
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
      round.settle(() => {
        // Through the console's total stringifier, never `String(rejection)`: a caught
        // value has nothing established about it, and this probe is held to the same
        // rule the readings it stands in for are.
        this.#publishChanges({ refusal: lossyStringify(rejection) });
      });
    }
  }

  #publishChanges(changes: Partial<Omit<ProbeSnapshot, "revision">>): void {
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

    reading.requestRead("participant-request");
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

  it("supersedes the read before it where a reading declares that rule", async () => {
    const clock = new ManualClock(0);
    const resolvers: ((value: string) => void)[] = [];
    const reading = new ProbeReading({
      clock,
      supersedes: true,
      read: () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    });

    reading.requestRead("subscribe");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();
    // The scheduler serializes, so a second reason raised now becomes the NEXT read
    // rather than a parallel one — which is why the first has to be let go first.
    resolvers[0]?.("first");
    await settleMicrotasks();

    reading.requestRead("participant-request");
    clock.advance(PAST_DEBOUNCE_MS);
    await settleMicrotasks();
    resolvers[1]?.("second");
    await settleMicrotasks();

    expect(reading.readsEntered).toHaveLength(2);
    expect(reading.snapshot().reading).toStrictEqual({ kind: "answered", value: "second" });
    expect(reading.snapshot().revision).toBe(2);
  });
});
