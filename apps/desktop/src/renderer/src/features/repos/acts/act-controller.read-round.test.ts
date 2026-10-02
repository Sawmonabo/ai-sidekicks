// The prerequisite half's round: which signal a read is handed, and what ends it. Real class,
// scheduler and scope; only the read closure is the test's, so a case can hold an answer open,
// capture its signal and settle it later. No overlapping-reads case: the scheduler serializes,
// so supersession is only reached between reads, and that is what is asserted.

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { PrerequisiteReader } from "./act-controller.js";
import { flush, runScheduledRead } from "./act-controller.test-support.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

/** The frames this reading would re-read on. Never fired here; declared to be read. */
const TRIGGERING_KINDS: ReadonlySet<string> = new Set(["workspace.ready"]);

interface StartedRead {
  readonly question: string;
  readonly signal: AbortSignal;
  serve(value: string): void;
}

interface OpenedReader {
  readonly reader: PrerequisiteReader<string>;
  readonly clock: ManualClock;
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
    // Captures the signal instead of consuming it, so a case can check what ended the read.
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

function signalOf(reads: readonly StartedRead[], index: number): AbortSignal {
  const read = reads[index];
  if (read === undefined) {
    throw new Error(`the reader performed ${String(reads.length)} reads, not ${String(index + 1)}`);
  }
  return read.signal;
}

describe("PrerequisiteReader — a read is performed inside a round", () => {
  it("abandons the read in flight on dispose and installs nothing", async () => {
    // The pane closed mid-read: the signal is aborted, so `callDaemon` drops the pending call
    // and the late answer settles nowhere.
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
    // The question is held constant so only the round can tell the two reads apart.
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
    // By the time the second question is read, the first read's round is over.
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
    // A withdrawal fires no read, so no newer round supersedes the one in flight; the question
    // check is what keeps its answer off screen.
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
