// The prerequisite half's round: which signal a read is handed, and what ends it.
//
// A SUITE OF ITS OWN AND NOT MORE CASES IN `act-controller.test.ts`. That file drives
// both halves through every arm and is about what they PUBLISH; these cases are about the
// pairing underneath — that a prerequisite read is performed inside a round, that the
// round is the scheduler's own rather than a second register beside it, and that the two
// ways a round ends reach the read itself and not only its settlement.
//
// THE REAL CLASS, THE REAL SCHEDULER, AND THE REAL SCOPE. Only the read closure is the
// test's — it is a parameter of the class — which is what lets these cases hold an
// answer open, capture the signal the reader handed it, and settle it afterwards.
//
// WHY THERE IS NO OVERLAPPING-READS CASE. `RefreshScheduler` serializes: a request made
// while a read is in flight becomes the NEXT read rather than a parallel one, so this
// reader can never have two reads outstanding and the round's supersession arm is only
// ever reached BETWEEN reads. That is asserted below as the property it is — consecutive
// fires get different signals, and the older is aborted — rather than staged as a race
// the class cannot produce.

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { PrerequisiteReader } from "./act-controller.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

/** The frames this reading would re-read on. Never fired here; declared to be read. */
const TRIGGERING_KINDS: ReadonlySet<string> = new Set(["workspace.ready"]);

/** One read the reader started: the signal it was given, and its held answer. */
interface StartedRead {
  readonly question: string;
  readonly signal: AbortSignal;
  serve(value: string): void;
}

interface OpenedReader {
  readonly reader: PrerequisiteReader<string>;
  readonly clock: ManualClock;
  /** Every read the reader performed, in order, with the round it was handed. */
  readonly reads: StartedRead[];
}

function open(): OpenedReader {
  const clock = new ManualClock();
  const reads: StartedRead[] = [];
  const reader = new PrerequisiteReader<string>({
    label: "prerequisite reader read round reading",
    clock,
    sessionStore: new SessionStore({ sessionId: "session-under-test" }),
    triggeringEventKinds: TRIGGERING_KINDS,
    // The whole instrument: the signal the reader supplies is captured rather than
    // consumed, so a case can read it after the fact and say what ended the read.
    readPrerequisite: async (question: string, signal: AbortSignal) => {
      let serve: (value: string) => void = () => undefined;
      const answer = new Promise<string>((resolve) => {
        serve = resolve;
      });
      reads.push({ question, signal, serve });
      return await answer;
    },
  });
  return { reader, clock, reads };
}

/** Let every pending microtask land. Nothing here is timer-driven but the debounce. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

/** Move past the debounce so the scheduler performs whatever was requested. */
async function runScheduledRead(clock: ManualClock): Promise<void> {
  await flush();
  clock.advance(REFRESH_DEBOUNCE_MS);
  await flush();
}

/** The signal of the read at `index`, or a failure naming what the scan found. */
function signalOf(reads: readonly StartedRead[], index: number): AbortSignal {
  const read = reads[index];
  if (read === undefined) {
    throw new Error(`the reader performed ${String(reads.length)} reads, not ${String(index + 1)}`);
  }
  return read.signal;
}

describe("PrerequisiteReader — a read is performed inside a round", () => {
  it("hands the read a signal, and it is live while the surface is", async () => {
    // The floor every case below rests on. A reader that passed `undefined` — or that
    // never called the closure at all — would make each assertion vacuous.
    const { reader, clock, reads } = open();
    reader.ask("first", "subscribe");
    await runScheduledRead(clock);
    expect(reads).toHaveLength(1);
    expect(signalOf(reads, 0).aborted).toBe(false);
    reader.dispose();
  });

  it("negative control: disposing abandons the read in flight and installs nothing", async () => {
    // THE CASE THE ROUND EXISTS FOR. The pane closed while the prerequisite was
    // outstanding: the signal it holds is aborted, so the door drops the pending call
    // and parses nothing, and the answer that lands afterwards settles nowhere.
    const { reader, clock, reads } = open();
    reader.ask("first", "subscribe");
    await runScheduledRead(clock);
    expect(signalOf(reads, 0).aborted).toBe(false);

    reader.dispose();
    expect(signalOf(reads, 0).aborted).toBe(true);

    reads[0]?.serve("too late");
    await flush();
    expect(reader.snapshot.status).toBe("reading");
  });

  it("opens a round per fire, so the older read's signal is aborted by the newer", async () => {
    // THE QUESTION IS HELD CONSTANT, which is what isolates the round from the
    // `#question` check: both reads ask the same thing, so nothing but the round
    // distinguishes them, and the older signal moving is the round doing it.
    const { reader, clock, reads } = open();
    reader.ask("held", "subscribe");
    await runScheduledRead(clock);
    reads[0]?.serve("first answer");
    await flush();

    reader.requestRead("window-focus");
    await runScheduledRead(clock);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.question).toBe("held");
    expect(signalOf(reads, 1)).not.toBe(signalOf(reads, 0));
    expect(signalOf(reads, 0).aborted).toBe(true);
    expect(signalOf(reads, 1).aborted).toBe(false);
    reader.dispose();
  });

  it("a superseded question's reply installs nothing while the newer one does", async () => {
    // The published half of supersession, and the signal half beside it: by the time
    // the second question is being read, the first read's round is over.
    const { reader, clock, reads } = open();
    reader.ask("first", "user-request");
    await runScheduledRead(clock);
    reader.ask("second", "user-request");
    reads[0]?.serve("first answer");
    await flush();
    expect(reader.snapshot.status).toBe("reading");

    await runScheduledRead(clock);
    expect(reads[1]?.question).toBe("second");
    expect(signalOf(reads, 0).aborted).toBe(true);
    reads[1]?.serve("second answer");
    await flush();
    const prerequisite = reader.snapshot;
    expect(prerequisite.status === "read" && prerequisite.value).toBe("second answer");
    reader.dispose();
  });

  it("a withdrawn question's answer installs nothing, and no round is opened for it", async () => {
    // A withdrawal fires NO read, so there is no newer round to supersede the one in
    // flight — which is exactly why the question check is a separate fact and not a
    // second copy of the round's rule.
    const { reader, clock, reads } = open();
    reader.ask("first", "user-request");
    await runScheduledRead(clock);
    reader.withdraw();
    expect(reader.snapshot.status).toBe("not-read");

    reads[0]?.serve("too late");
    await flush();
    expect(reads).toHaveLength(1);
    expect(reader.snapshot.status).toBe("not-read");
    reader.dispose();
  });
});
