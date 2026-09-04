// A stamped read is about its source and its subject on every committed render, or it
// is not stamped.
//
// The three claims here are the ones the three workflow read hooks were all getting
// wrong in their own way, so they are asserted on the helper rather than three times
// over: the first committed render for a subject is `reading`, the render that brings a
// new subject is `reading` too, and so is the render that brings a new SOURCE under an
// unchanged subject — never the previous pair's answer.
//
// Every case drives the REAL hook through a rendered probe, and reads what each COMMIT
// carried rather than what each render call saw. `subject-stamped-state.test-support.tsx`
// owns that probe and states why the distinction decides the outcome.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useSubjectStampedRead, type SubjectStampedRead } from "./subject-stamped-state.js";
import {
  latestCommitted,
  observeStampedRead,
  type ObservedStampedRead,
} from "./subject-stamped-state.test-support.js";

/** What a settled read looks like in these cases: an answer with something in it. */
type SettledProbeRead = { readonly status: "served"; readonly answer: string };

/**
 * The two sources a case swaps between.
 *
 * Objects with no members, because identity is the whole of what the stamp compares —
 * a port is minted once per bridge, so what a case has to model is two references and
 * not two behaviours.
 */
const PROBE_SOURCE: object = {};
const SECOND_PROBE_SOURCE: object = {};

const PROBE_SUBJECT = "run-a";
const SECOND_PROBE_SUBJECT = "run-b";

/** Everything a case needs to drive one stamped read. */
interface ProbeReading {
  readonly state: SubjectStampedRead<SettledProbeRead>;
  readonly settle: (answer: string) => void;
}

function useProbeRead(source: object, subject: string | undefined): ProbeReading {
  const [state, setState] = useSubjectStampedRead<SettledProbeRead>(source, subject);
  return {
    state,
    settle: (answer) => {
      setState({ status: "served", answer });
    },
  };
}

function observeProbe(
  subject: string | undefined,
  source: object = PROBE_SOURCE,
): ObservedStampedRead<object, ProbeReading> {
  return observeStampedRead(useProbeRead, { source, subject });
}

function statusesOf(committed: readonly ProbeReading[]): readonly string[] {
  return committed.map((reading) => reading.state.status);
}

/** Settle the read as it stands, so a later case can prove the answer is discarded. */
function settleLatest(probe: ObservedStampedRead<object, ProbeReading>, answer: string): void {
  act(() => {
    latestCommitted(probe.committed).settle(answer);
  });
}

describe("useSubjectStampedRead — the state is about the subject on screen", () => {
  afterEach(() => {
    cleanup();
  });

  it("is already reading on the very first render a subject is in scope for", () => {
    // The defect this replaces: the three read hooks seeded `unasked` and moved to
    // `reading` from an effect, which runs after the commit — so one painted frame
    // claimed nobody had asked about a subject whose request was already out.
    expect(statusesOf(observeProbe(PROBE_SUBJECT).committed)).toEqual(["reading"]);
  });

  it("negative control: a read addressed at no subject stays unasked", () => {
    // Without this, the case above passes for a hook that answered `reading` to
    // everything — including an address with no question in it, where a spinner
    // promises an answer that is never coming.
    expect(statusesOf(observeProbe(undefined).committed)).toEqual(["unasked"]);
  });

  it("commits reading, and never the old answer, on the render that brings a new subject", () => {
    const probe = observeProbe(PROBE_SUBJECT);
    settleLatest(probe, "the first subject's answer");
    const commitsBeforeRetarget = probe.committed.length;

    act(() => {
      probe.readdress({ source: PROBE_SOURCE, subject: SECOND_PROBE_SUBJECT });
    });

    // Nothing served is committed under the new subject. Before the stamp, A's answer
    // was renderable under B's address until an effect got round to resetting it.
    expect(statusesOf(probe.committed.slice(commitsBeforeRetarget))).not.toContain("served");
    expect(latestCommitted(probe.committed).state.status).toBe("reading");
  });

  it("negative control: a re-render at the SAME pair keeps the answer it settled on", () => {
    // Without this, the cases either side pass for a hook that reset on every render,
    // which would re-read forever and never show an answer at all.
    const probe = observeProbe(PROBE_SUBJECT);
    settleLatest(probe, "the first subject's answer");

    act(() => {
      probe.readdress({ source: PROBE_SOURCE, subject: PROBE_SUBJECT });
    });

    expect(latestCommitted(probe.committed).state).toEqual({
      status: "served",
      answer: "the first subject's answer",
    });
  });

  it("commits unasked, and never the old answer, when the subject goes away", () => {
    const probe = observeProbe(PROBE_SUBJECT);
    settleLatest(probe, "the first subject's answer");

    act(() => {
      probe.readdress({ source: PROBE_SOURCE, subject: undefined });
    });

    expect(latestCommitted(probe.committed).state.status).toBe("unasked");
  });
});

describe("useSubjectStampedRead — the state is about the source it was read through", () => {
  afterEach(() => {
    cleanup();
  });

  it("commits reading, and never the old source's answer, when the source is replaced", () => {
    // The defect: the stamp was the subject alone, so replacing the port under an
    // unchanged subject left the state agreeing with itself and the previous source's
    // entities were committed for one frame before the passive effect took them down.
    // The fixture's scenario switch does exactly that — a new bridge, the same session.
    const probe = observeProbe(PROBE_SUBJECT);
    settleLatest(probe, "the first source's answer");
    const commitsBeforeSwap = probe.committed.length;

    act(() => {
      probe.readdress({ source: SECOND_PROBE_SOURCE, subject: PROBE_SUBJECT });
    });

    expect(statusesOf(probe.committed.slice(commitsBeforeSwap))).not.toContain("served");
    expect(latestCommitted(probe.committed).state.status).toBe("reading");
  });

  it("negative control: a source swap over no subject still commits unasked", () => {
    // Without this, the case above passes for a hook that answered `reading` to every
    // source change — including one where there is still no question to put, so a
    // spinner would promise an answer that is never coming.
    const probe = observeProbe(undefined);

    act(() => {
      probe.readdress({ source: SECOND_PROBE_SOURCE, subject: undefined });
    });

    expect(statusesOf(probe.committed)).toEqual(["unasked", "unasked"]);
  });
});
