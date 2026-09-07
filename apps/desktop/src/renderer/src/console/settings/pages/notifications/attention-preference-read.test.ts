// Two reads of one preference set, and which of them the section is allowed to show.
//
// Every case here drives the reading directly rather than through the page, because
// what is under test is a property of two calls overlapping — which reply installs,
// and what the rows are allowed to do while the second one is still out — and a
// rendered page can only show the outcome after the fact. The reads are HELD by hand
// for the same reason the writer's ordering harness held them: an older reply is only
// genuinely older if it was taken earlier and answered later, and nothing else makes
// that difference observable.

import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { ManualClock, REFRESH_MAX_WAIT_MS } from "../../../core/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import type {
  AttentionPreference,
  AttentionPreferenceReadOutcome,
} from "./attention-preference-model.js";
import { AttentionPreferenceRead } from "./attention-preference-read.js";

const PARTICIPANT_ID = "participant-ana";

const SCENARIO = unscriptedScenario("notifications-preference-read-test");

/** One stored record, so a served reply is distinguishable from every other one. */
function preferences(memberValue: boolean): readonly AttentionPreference[] {
  return [{ key: "attention", value: { mentions: memberValue } }];
}

function servedSet(memberValue: boolean): AttentionPreferenceReadOutcome {
  return { status: "served", value: { preferences: preferences(memberValue) } };
}

/** What one held read answers, once a case decides it has. */
interface HeldRead {
  serve(outcome: AttentionPreferenceReadOutcome): void;
  reject(rejection: unknown): void;
}

/**
 * A bridge whose preference read is answered by hand, one call at a time.
 *
 * The real fixture bridge with the one operation these cases drive overridden, so what
 * they assert is what a release build's port shape produces.
 */
function bridgeHoldingItsReads(): {
  readonly bridge: ConsoleBridge;
  readonly held: readonly HeldRead[];
  readonly clock: ManualClock;
} {
  const held: HeldRead[] = [];
  const clock = new ManualClock();
  const bridge = fixtureBridgeWithGrowth(SCENARIO, {
    attentionPreferenceRead: async () =>
      await new Promise<AttentionPreferenceReadOutcome>((resolve, reject) => {
        held.push({ serve: resolve, reject });
      }),
  });
  return { bridge, held, clock };
}

function readingOver(bridge: ConsoleBridge, clock: ManualClock): AttentionPreferenceRead {
  return new AttentionPreferenceRead({ bridge, participantId: PARTICIPANT_ID, clock });
}

/** The stored member the section would render from the reading as it stands. */
function shownMemberValue(read: AttentionPreferenceRead): boolean | undefined {
  const { reading } = read.snapshot();
  if (reading?.kind !== "answered" || reading.outcome.status !== "served") {
    return undefined;
  }
  return reading.outcome.value.preferences[0]?.value["mentions"];
}

/** Let a settled reply reach the reading's own publication. */
async function drain(): Promise<void> {
  await crossMacrotaskBoundary();
}

describe("the attention preference read — two reads of one set", () => {
  it("keeps the newer answer when an older read replies behind it", async () => {
    // The defect. A window-focus read taken before a write and answered after that
    // write's re-read replaced the set with the value the daemon held BEFORE the
    // write, so the toggle a person watched settle flipped back on screen.
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    void read.readSet();
    void read.readSet();
    await drain();
    expect(held).toHaveLength(2);

    // The newer read answers first, then the older one.
    held[1]?.serve(servedSet(false));
    await drain();
    held[0]?.serve(servedSet(true));
    await drain();

    expect(shownMemberValue(read)).toBe(false);
  });

  it("negative control: a lone read still installs what it answered", async () => {
    // Without this, the case above would hold for a reading that had stopped
    // publishing at all — which would freeze the section on its opening state.
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    void read.readSet();
    await drain();
    held[0]?.serve(servedSet(true));
    await drain();

    expect(shownMemberValue(read)).toBe(true);
  });

  it("installs nothing from a superseded read that rejected", async () => {
    // A rejection publishes the refusal in place of the rows, so an older one landing
    // last would replace a set the newer read had already served.
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    // The FIRST read is the one that will reject, and it is superseded by the second
    // before it does — so its rejection is caught here rather than left to become an
    // unhandled one, which is what the writer's own catch does in production.
    const superseded = read.readSet();
    superseded.catch(() => undefined);
    void read.readSet();
    await drain();

    held[1]?.serve(servedSet(true));
    await drain();
    held[0]?.reject(new Error("the preference read never reached the store"));
    await drain();

    expect(read.snapshot().reading?.kind).toBe("answered");
  });

  it("negative control: a lone rejection does render as a refusal", async () => {
    // Without this, the case above would hold for a reading that never published a
    // rejection at all — which is the state that reports a failed read as one still
    // in flight for the life of the window.
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    const rejected = read.readSet();
    rejected.catch(() => undefined);
    await drain();
    held[0]?.reject(new Error("the preference read never reached the store"));
    await drain();

    expect(read.snapshot().reading?.kind).toBe("unreadable");
  });
});

describe("the attention preference read — what in flight means", () => {
  it("stays in flight while a newer read is still out", async () => {
    // The second half of the defect: the FIRST completion cleared the flag, so the
    // rows went pressable against a value the console was in the middle of replacing.
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    void read.readSet();
    void read.readSet();
    await drain();

    held[0]?.serve(servedSet(true));
    await drain();

    expect(read.snapshot().isReadInFlight).toBe(true);
  });

  it("negative control: the flag does clear once every read has settled", async () => {
    // Without this, the case above would hold for a reading whose flag was stuck true
    // forever — which locks every switch on the page for the life of the window.
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    void read.readSet();
    void read.readSet();
    await drain();

    held[0]?.serve(servedSet(true));
    held[1]?.serve(servedSet(false));
    await drain();

    expect(read.snapshot().isReadInFlight).toBe(false);
  });

  it("is in flight from the moment a trigger asks, before the scheduler performs", async () => {
    // The rows lock when the window comes back rather than when the call goes out:
    // the scheduler debounces, and a section that waited for the call would offer
    // presses against a set it has already decided to replace.
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    read.requestRead("window-focus");

    expect(read.snapshot().isReadInFlight).toBe(true);
    expect(held).toHaveLength(0);
  });

  it("stays in flight when a trigger arrives while a read is still out", async () => {
    // The scheduler serializes, so the requested read becomes the NEXT one. Clearing
    // the flag on the first completion would unlock the rows for the gap between two
    // reads the console has already committed to taking.
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    read.requestRead("subscribe");
    clock.advance(REFRESH_MAX_WAIT_MS);
    await drain();
    expect(held).toHaveLength(1);

    read.requestRead("window-focus");
    held[0]?.serve(servedSet(true));
    await drain();

    expect(read.snapshot().isReadInFlight).toBe(true);
  });

  it("negative control: no trigger behind it, and the scheduled read clears the flag", async () => {
    // Without this, the case above would hold for a flag that never cleared after a
    // scheduled read at all, and the two would be indistinguishable.
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    read.requestRead("subscribe");
    clock.advance(REFRESH_MAX_WAIT_MS);
    await drain();
    held[0]?.serve(servedSet(true));
    await drain();

    expect(read.snapshot().isReadInFlight).toBe(false);
  });
});

describe("the attention preference read — what it refuses to do", () => {
  it("asks nothing before a participant has been resolved", async () => {
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = new AttentionPreferenceRead({ bridge, participantId: undefined, clock });

    read.requestRead("subscribe");
    clock.advance(REFRESH_MAX_WAIT_MS);
    await drain();

    // A set read under a guessed participant puts one person's answers on another
    // person's screen; the reading fails closed rather than composing one.
    expect(held).toHaveLength(0);
    expect(read.snapshot().isReadInFlight).toBe(false);
  });

  it("asks nothing once disposed, and publishes nothing a late reply carries", async () => {
    const { bridge, held, clock } = bridgeHoldingItsReads();
    const read = readingOver(bridge, clock);

    void read.readSet();
    await drain();
    read.dispose();
    held[0]?.serve(servedSet(true));
    await drain();

    read.requestRead("window-focus");
    clock.advance(REFRESH_MAX_WAIT_MS);
    await drain();

    expect(read.snapshot().reading).toBeUndefined();
    expect(held).toHaveLength(1);
  });
});
