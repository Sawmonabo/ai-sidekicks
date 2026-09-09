// The prerequisite half's round: which signal a read is handed, and what ends it.
//
// A SUITE OF ITS OWN AND NOT MORE CASES IN `act-controller.test.ts`. That file drives
// both halves through every arm and is about what the controller PUBLISHES; these
// cases are about the pairing underneath — that a prerequisite read is performed
// inside a round, that the round is the scheduler's own rather than a second register
// beside it, and that the two ways a round ends reach the read itself and not only its
// settlement. Splitting them keeps each file's subject singular, which is the seam
// `apps/desktop/AGENTS.md` §Module shape splits on.
//
// THE REAL CLASS, THE REAL SCHEDULER, AND THE REAL SCOPE. Only the read closure is the
// test's — it is a parameter of the class — which is what lets these cases hold an
// answer open, capture the signal the machine handed it, and settle it afterwards.
//
// WHY THERE IS NO OVERLAPPING-READS CASE. `RefreshScheduler` serializes: a request made
// while a read is in flight becomes the NEXT read rather than a parallel one, so this
// controller can never have two prerequisite reads outstanding and the round's
// supersession arm is only ever reached BETWEEN reads. That is asserted below as the
// property it is — consecutive fires get different signals, and the older is aborted —
// rather than staged as a race the class cannot produce.

import { describe, expect, it } from "vitest";

import { ManualClock, REFRESH_DEBOUNCE_MS, type ConsoleRefusal } from "../../core/index.js";
import { ActController } from "./act-controller.js";
import type { ActOutcome } from "./act-reading.js";
import { SessionStore } from "../session/session-store.js";

/** The subsystem these refusals name as their author. */
const TEST_ORIGIN = "act-controller-read-round-test";

/** The frames this reading would re-read on. Never fired here; declared to be read. */
const TRIGGERING_KINDS: ReadonlySet<string> = new Set(["repo.mount_attached"]);

/** What a settled act publishes in these cases. Unused here; the type needs an arm. */
interface TestSettlement {
  readonly status: "done";
  readonly value: string;
}

/** One read the machine started: the signal it was given, and its held answer. */
interface StartedRead {
  readonly question: string;
  readonly signal: AbortSignal;
  serve(value: string): void;
  reject(rejection: unknown): void;
}

interface OpenedController {
  readonly controller: ActController<string, TestSettlement>;
  readonly clock: ManualClock;
  /** Every read the machine performed, in order, with the round it was handed. */
  readonly reads: StartedRead[];
}

function open(): OpenedController {
  const clock = new ManualClock();
  const reads: StartedRead[] = [];
  const controller = new ActController<string, TestSettlement>({
    label: "act controller read round reading",
    clock,
    sessionStore: new SessionStore({ sessionId: "session-under-test" }),
    triggeringEventKinds: TRIGGERING_KINDS,
    refusalOrigin: TEST_ORIGIN,
    // The whole instrument: the signal the machine supplies is captured rather than
    // consumed, so a case can read it after the fact and say what ended the read.
    readPrerequisite: async (question: string, signal: AbortSignal) => {
      let serve: (value: string) => void = () => undefined;
      let reject: (rejection: unknown) => void = () => undefined;
      const answer = new Promise<ActOutcome<string>>((resolve, fail) => {
        serve = (value: string) => {
          resolve({ status: "served", value });
        };
        reject = fail;
      });
      reads.push({ question, signal, serve, reject });
      return await answer;
    },
    readRejection: { code: "call-rejected", detail: "The read did not complete." },
  });
  return { controller, clock, reads };
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
    throw new Error(
      `the machine performed ${String(reads.length)} reads, not ${String(index + 1)}`,
    );
  }
  return read.signal;
}

describe("ActController — a prerequisite read is performed inside a round", () => {
  it("hands the read a signal, and it is live while the surface is", async () => {
    // The floor every case below rests on. A machine that passed `undefined` — or that
    // never called the closure at all — would make each assertion vacuous.
    const { controller, clock, reads } = open();
    controller.ask("first", "subscribe");
    await runScheduledRead(clock);
    expect(reads).toHaveLength(1);
    expect(signalOf(reads, 0).aborted).toBe(false);
    controller.dispose();
  });

  it("negative control: disposing abandons the read in flight and installs nothing", async () => {
    // THE CASE THE ROUND EXISTS FOR. The pane closed while the prerequisite was
    // outstanding: the signal it holds is aborted, so the door drops the pending call
    // and parses nothing, and the answer that lands afterwards settles nowhere.
    const { controller, clock, reads } = open();
    controller.ask("first", "subscribe");
    await runScheduledRead(clock);
    expect(signalOf(reads, 0).aborted).toBe(false);

    controller.dispose();
    expect(signalOf(reads, 0).aborted).toBe(true);

    reads[0]?.serve("too late");
    await flush();
    expect(controller.snapshot.prerequisite.status).toBe("reading");
  });

  it("negative control: a rejection after disposal publishes no refusal either", async () => {
    // The other arm of the same claim. A read whose owner is gone AND that failed must
    // not compose a refusal about a call nobody has a question for any more — the
    // departure is the fact that explains the settlement.
    const { controller, clock, reads } = open();
    controller.ask("first", "subscribe");
    await runScheduledRead(clock);
    controller.dispose();
    reads[0]?.reject(new Error("the namespace is gone"));
    await flush();
    expect(controller.snapshot.prerequisite.status).toBe("reading");
  });

  it("opens a round per fire, so the older read's signal is aborted by the newer", async () => {
    // THE QUESTION IS HELD CONSTANT, which is what isolates the round from the
    // `#question` check: both reads ask the same thing, so nothing but the round
    // distinguishes them, and the older signal moving is the round doing it.
    const { controller, clock, reads } = open();
    controller.ask("held", "subscribe");
    await runScheduledRead(clock);
    reads[0]?.serve("first answer");
    await flush();

    controller.requestRead("window-focus");
    await runScheduledRead(clock);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.question).toBe("held");
    expect(signalOf(reads, 1)).not.toBe(signalOf(reads, 0));
    expect(signalOf(reads, 0).aborted).toBe(true);
    expect(signalOf(reads, 1).aborted).toBe(false);
    controller.dispose();
  });

  it("a superseded question's reply installs nothing while the newer one does", async () => {
    // The published half of supersession, and the signal half beside it: by the time
    // the second question is being read, the first read's round is over.
    const { controller, clock, reads } = open();
    controller.ask("first", "participant-request");
    await runScheduledRead(clock);
    controller.ask("second", "participant-request");
    reads[0]?.serve("first answer");
    await flush();
    expect(controller.snapshot.prerequisite.status).toBe("reading");

    await runScheduledRead(clock);
    expect(reads[1]?.question).toBe("second");
    expect(signalOf(reads, 0).aborted).toBe(true);
    reads[1]?.serve("second answer");
    await flush();
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status === "read" && prerequisite.value).toBe("second answer");
    controller.dispose();
  });

  it("a withdrawn question's answer installs nothing, and no round is opened for it", async () => {
    // A withdrawal fires NO read, so there is no newer round to supersede the one in
    // flight — which is exactly why the question check is a separate fact and not a
    // second copy of the round's rule.
    const { controller, clock, reads } = open();
    controller.ask("first", "participant-request");
    await runScheduledRead(clock);
    controller.withdraw();
    expect(controller.snapshot.prerequisite.status).toBe("not-read");

    reads[0]?.serve("too late");
    await flush();
    expect(reads).toHaveLength(1);
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
    controller.dispose();
  });

  it("negative control: the refusal the read answers with still reaches the surface", async () => {
    // Without this the abandonment cases could pass over a machine that swallowed
    // every prerequisite answer. A refusal is not an abandonment, and it renders.
    const { controller, clock, reads } = open();
    controller.ask("first", "subscribe");
    await runScheduledRead(clock);
    reads[0]?.reject(new Error("the namespace is gone"));
    await flush();
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("refused");
    const refusal: ConsoleRefusal | undefined =
      prerequisite.status === "refused" ? prerequisite.refusal : undefined;
    expect(refusal?.code).toBe("call-rejected");
    controller.dispose();
  });
});
