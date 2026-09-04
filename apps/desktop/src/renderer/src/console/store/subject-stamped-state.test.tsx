// A stamped read is about its subject on every committed render, or it is not stamped.
//
// The two claims here are the ones the three workflow read hooks were all getting
// wrong in their own way, so they are asserted on the helper rather than three times
// over: the first committed render for a subject is `reading`, and the render that
// brings a new subject is `reading` too — never the previous subject's answer.
//
// Every case drives the REAL hook through a rendered probe. A test that called the
// function outside React would be measuring a closure rather than the render-time
// adjustment, which is the whole mechanism.
//
// THE PROBE RECORDS COMMITTED STATES AND NOT RENDER CALLS, which is the difference the
// mechanism turns on. Setting state during a render makes React DISCARD that pass and
// re-run it, so the discarded pass still sees the stale value — a log written from the
// render body would show the old subject's answer and prove nothing about what a
// person ever saw. An effect runs once per COMMIT, which is exactly the frame a
// surface paints and assistive technology reads.

import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { subjectReadStart, useSubjectStampedRead } from "./subject-stamped-state.js";

/** What a settled read looks like in these cases: an answer with something in it. */
type SettledProbeRead = { readonly status: "served"; readonly answer: string };

/** Everything a case needs to drive one stamped read. */
interface ProbeReading {
  readonly state:
    | { readonly status: "unasked" }
    | { readonly status: "reading" }
    | SettledProbeRead;
  readonly settle: (answer: string) => void;
}

function StampedReadProbe(props: {
  readonly subject: string | undefined;
  readonly onCommit: (reading: ProbeReading) => void;
}): React.JSX.Element {
  const [state, setState] = useSubjectStampedRead<SettledProbeRead>(props.subject);
  const reading: ProbeReading = {
    state,
    settle: (answer) => {
      setState({ status: "served", answer });
    },
  };
  useEffect(() => {
    props.onCommit(reading);
  });
  return <></>;
}

/** Render the probe at one subject, collecting every state it commits. */
function observeStampedRead(subject: string | undefined): {
  readonly observed: readonly ProbeReading[];
  readonly retarget: (next: string | undefined) => void;
} {
  const observed: ProbeReading[] = [];
  const collect = (reading: ProbeReading): void => {
    observed.push(reading);
  };
  const view = render(<StampedReadProbe subject={subject} onCommit={collect} />);
  return {
    observed,
    retarget: (next) => {
      view.rerender(<StampedReadProbe subject={next} onCommit={collect} />);
    },
  };
}

function statusesOf(observed: readonly ProbeReading[]): readonly string[] {
  return observed.map((reading) => reading.state.status);
}

function latest(observed: readonly ProbeReading[]): ProbeReading {
  const reading = observed.at(-1);
  if (reading === undefined) {
    throw new Error("the probe never rendered, so there is nothing to read");
  }
  return reading;
}

describe("subjectReadStart — what a read starts as", () => {
  it("is reading where there is a subject and unasked where there is none", () => {
    expect(subjectReadStart("run-a").status).toBe("reading");
    expect(subjectReadStart(undefined).status).toBe("unasked");
  });
});

describe("useSubjectStampedRead — the state is about the subject on screen", () => {
  afterEach(() => {
    cleanup();
  });

  it("is already reading on the very first render a subject is in scope for", () => {
    // The defect this replaces: the three read hooks seeded `unasked` and moved to
    // `reading` from an effect, which runs after the commit — so one painted frame
    // claimed nobody had asked about a subject whose request was already out.
    const { observed } = observeStampedRead("run-a");
    expect(statusesOf(observed)).toEqual(["reading"]);
  });

  it("negative control: a read addressed at no subject stays unasked", () => {
    // Without this, the case above passes for a hook that answered `reading` to
    // everything — including an address with no question in it, where a spinner
    // promises an answer that is never coming.
    const { observed } = observeStampedRead(undefined);
    expect(statusesOf(observed)).toEqual(["unasked"]);
  });

  it("commits reading, and never the old answer, on the render that brings a new subject", () => {
    const probe = observeStampedRead("run-a");
    act(() => {
      latest(probe.observed).settle("run-a's answer");
    });
    expect(latest(probe.observed).state).toEqual({ status: "served", answer: "run-a's answer" });

    const rendersBeforeRetarget = probe.observed.length;
    act(() => {
      probe.retarget("run-b");
    });

    // Nothing served is committed under the new subject. Before the stamp, A's answer
    // was renderable under B's address until an effect got round to resetting it.
    expect(statusesOf(probe.observed.slice(rendersBeforeRetarget))).not.toContain("served");
    expect(latest(probe.observed).state.status).toBe("reading");
  });

  it("negative control: a re-render at the SAME subject keeps the answer it settled on", () => {
    // Without this, the case above passes for a hook that reset on every render, which
    // would re-read forever and never show an answer at all.
    const probe = observeStampedRead("run-a");
    act(() => {
      latest(probe.observed).settle("run-a's answer");
    });

    act(() => {
      probe.retarget("run-a");
    });

    expect(latest(probe.observed).state).toEqual({ status: "served", answer: "run-a's answer" });
  });

  it("commits unasked, and never the old answer, when the subject goes away", () => {
    const probe = observeStampedRead("run-a");
    act(() => {
      latest(probe.observed).settle("run-a's answer");
    });

    act(() => {
      probe.retarget(undefined);
    });

    expect(latest(probe.observed).state.status).toBe("unasked");
  });
});
