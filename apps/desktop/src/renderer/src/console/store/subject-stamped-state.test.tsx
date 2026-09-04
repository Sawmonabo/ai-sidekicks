// What a stamp buys, and what it must not cost.
//
// Three properties, and each one has the case that fails on the code without it:
//
//   1. **The substitution happens in the render that first sees the new subject.**
//      Asserted synchronously, with no settling pass — the whole defect lives in the
//      interval between the subject changing and the replacement answer arriving, so
//      a case that settled first could not observe it.
//   2. **A publish for a retired subject is dropped, not installed.** The negative
//      control is the same publish for the CURRENT subject, which must land: a hook
//      that dropped everything would pass the first half on its own.
//   3. **A subject that has not moved keeps its value.** The other negative control,
//      and the one a comparison written as "always reset" would fail.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useSubjectStampedState, type SubjectStamp } from "./subject-stamped-state.js";

const NOTHING_READ = "nothing read yet";

/** The publisher a case drives, captured out of the render it was handed to. */
interface StampedProbe {
  readonly rendered: () => string;
  readonly publish: (subject: SubjectStamp, value: string) => void;
}

function StampedReading(props: {
  readonly subject: SubjectStamp;
  readonly probe: { current?: (subject: SubjectStamp, value: string) => void };
}): React.JSX.Element {
  const [value, publish] = useSubjectStampedState<string>(props.subject, NOTHING_READ);
  props.probe.current = publish;
  return <p data-testid="reading">{value}</p>;
}

function renderProbe(subject: SubjectStamp): StampedProbe & {
  readonly rerenderWith: (nextSubject: SubjectStamp) => void;
} {
  const probe: { current?: (subject: SubjectStamp, value: string) => void } = {};
  const mounted = render(<StampedReading subject={subject} probe={probe} />);
  const publish = (publishedSubject: SubjectStamp, value: string): void => {
    act(() => {
      probe.current?.(publishedSubject, value);
    });
  };
  return {
    rendered: () => mounted.getByTestId("reading").textContent ?? "",
    publish,
    rerenderWith: (nextSubject) => {
      mounted.rerender(<StampedReading subject={nextSubject} probe={probe} />);
    },
  };
}

describe("useSubjectStampedState", () => {
  it("answers the unstamped value until something is published", () => {
    const probe = renderProbe(["session-a", "transport-1"]);
    expect(probe.rendered()).toBe(NOTHING_READ);
  });

  it("shows a value published for the current subject", () => {
    const subject: SubjectStamp = ["session-a", "transport-1"];
    const probe = renderProbe(subject);

    probe.publish(subject, "roster of a");

    expect(probe.rendered()).toBe("roster of a");
  });

  it("drops the held value in the render that first sees a new subject", () => {
    // No settling pass on purpose: this is the interval the whole module exists for.
    const firstSubject: SubjectStamp = ["session-a", "transport-1"];
    const probe = renderProbe(firstSubject);
    probe.publish(firstSubject, "roster of a");

    probe.rerenderWith(["session-a", "transport-2"]);

    expect(probe.rendered()).toBe(NOTHING_READ);
  });

  it("compares every entry, not the first one", () => {
    // The near miss this module replaces: a comparison keyed on one input alone
    // leaves the held value standing when only the other input moved.
    const firstTransport = { name: "transport-1" };
    const secondTransport = { name: "transport-2" };
    const probe = renderProbe(["session-a", firstTransport]);
    probe.publish(["session-a", firstTransport], "roster through the first transport");

    probe.rerenderWith(["session-a", secondTransport]);

    expect(probe.rendered()).toBe(NOTHING_READ);
  });

  it("negative control: a subject that has not moved keeps its value", () => {
    const probe = renderProbe(["session-a", "transport-1"]);
    probe.publish(["session-a", "transport-1"], "roster of a");

    // A FRESH array with the same entries — a caller builds its stamp per render,
    // so identity of the array itself must not be what the comparison reads.
    probe.rerenderWith(["session-a", "transport-1"]);

    expect(probe.rendered()).toBe("roster of a");
  });

  it("drops a publish that names a subject the caller has left", () => {
    const firstSubject: SubjectStamp = ["session-a", "transport-1"];
    const secondSubject: SubjectStamp = ["session-a", "transport-2"];
    const probe = renderProbe(firstSubject);
    probe.rerenderWith(secondSubject);
    probe.publish(secondSubject, "roster through the second transport");

    probe.publish(firstSubject, "roster through the retired transport");

    expect(probe.rendered()).toBe("roster through the second transport");
  });

  it("negative control: a publish for the current subject lands after a subject change", () => {
    // Without this, the case above would pass over a hook that dropped every
    // publish once the subject had ever moved.
    const secondSubject: SubjectStamp = ["session-a", "transport-2"];
    const probe = renderProbe(["session-a", "transport-1"]);
    probe.rerenderWith(secondSubject);

    probe.publish(secondSubject, "roster through the second transport");

    expect(probe.rendered()).toBe("roster through the second transport");
  });
});
