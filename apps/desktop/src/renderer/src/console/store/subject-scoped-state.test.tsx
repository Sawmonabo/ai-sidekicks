// What the holder promises, and what the shape it replaced actually did.
//
// Every clean assertion here is paired with a NEGATIVE CONTROL that drives the shape
// five families each wrote before this module existed — a plain `useState` reset from
// an effect — over the identical script, and shows it failing. Without that pairing
// "no frame carried the old subject" is a sentence about a test rather than about the
// code: a holder that never re-addressed at all would pass it too.
//
// Renders are COUNTED, not just inspected. The guarantee is not merely that the value
// is eventually right; it is that the pass which first sees a new subject already
// reads that subject's own seed. A holder that reached the same value by discarding a
// render pass would satisfy every value assertion and cost a frame per re-address on
// a surface the deck re-addresses on every pane move.

import { act, render } from "@testing-library/react";
import { useEffect, useState, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { SubjectScopedHolder, useSubjectScopedState } from "./subject-scoped-state.js";

/** Two subjects, compared by identity exactly as a bridge or a port would be. */
const SUBJECT_ONE = { name: "subject one" };
const SUBJECT_TWO = { name: "subject two" };

/** What every render recorded: the subject it was about and the value it read. */
interface RecordedFrame {
  readonly key: string | undefined;
  readonly value: string;
}

/** The frames one mount painted, in order. A class so the log cannot be reassigned. */
class FrameLog {
  readonly #frames: RecordedFrame[] = [];

  public record(frame: RecordedFrame): void {
    this.#frames.push(frame);
  }

  public get frames(): readonly RecordedFrame[] {
    return [...this.#frames];
  }

  public get renderCount(): number {
    return this.#frames.length;
  }

  /** Whether any frame claimed `value` while addressed at `key`. */
  public painted(key: string | undefined, value: string): boolean {
    return this.#frames.some((frame) => frame.key === key && frame.value === value);
  }
}

interface ProbeProps {
  readonly subject: object;
  readonly probeKey: string | undefined;
  readonly log: FrameLog;
  readonly onReady?: (
    publish: (next: string) => void,
    settle: () => (next: string) => void,
  ) => void;
}

/** The holder under test, driven through the public hook. */
function HolderProbe(props: ProbeProps): ReactElement {
  const { value, publish, settle } = useSubjectScopedState<string>(
    props.subject,
    props.probeKey,
    () => "seed",
  );
  props.log.record({ key: props.probeKey, value });
  props.onReady?.(publish, settle);
  return <output>{value}</output>;
}

/**
 * The shape this module replaced: state reset from an effect.
 *
 * Not a stand-in for the holder — it is the OLD code, kept only so the assertions
 * above it are shown to discriminate. A test that reimplements the rule it checks
 * proves nothing; this one implements the rule's opposite on purpose.
 */
function EffectResetProbe(props: ProbeProps): ReactElement {
  const [value, setValue] = useState("seed");
  const [stamped, setStamped] = useState(props.probeKey);
  useEffect(() => {
    if (stamped !== props.probeKey) {
      setStamped(props.probeKey);
      setValue("seed");
    }
  }, [props.probeKey, stamped]);
  props.log.record({ key: props.probeKey, value });
  props.onReady?.(
    (next: string) => {
      setValue(next);
    },
    () =>
      (next: string): void => {
        setValue(next);
      },
  );
  return <output>{value}</output>;
}

describe("SubjectScopedHolder — the rule, with no renderer involved", () => {
  it("seeds on the first address and keeps the value while the subject stands", () => {
    const holder = new SubjectScopedHolder<string>();
    let seedings = 0;
    const seed = (): string => {
      seedings += 1;
      return "seed";
    };
    holder.address(SUBJECT_ONE, "alpha", seed);
    holder.publisherFor(SUBJECT_ONE, "alpha")("published");
    holder.address(SUBJECT_ONE, "alpha", seed);
    expect(holder.value).toBe("published");
    expect(seedings).toBe(1);
  });

  it("discards the value the moment either half of the subject moves", () => {
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    holder.publisherFor(SUBJECT_ONE, "alpha")("published");
    holder.address(SUBJECT_ONE, "beta", () => "seed");
    expect(holder.value).toBe("seed");
    holder.publisherFor(SUBJECT_ONE, "beta")("published again");
    holder.address(SUBJECT_TWO, "beta", () => "seed");
    expect(holder.value).toBe("seed");
  });

  it("drops a publish captured under a subject that has since moved", () => {
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const lateSettlement = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_TWO, "alpha", () => "seed");
    lateSettlement("the answer to a question nobody is asking");
    expect(holder.value).toBe("seed");
  });

  it("drops a settlement from a visit the subject left and came back to", () => {
    // A route round-trip: s1 -> s2 -> s1. The pair is equal on the first and third
    // visits, so a guard that compared only the pair admitted the FIRST visit's
    // reply into the third visit's state — the older read landing last and
    // overwriting the answer the surface on screen had already been given.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheFirstVisit = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_TWO, "alpha", () => "seed");
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    holder.publisherFor(SUBJECT_ONE, "alpha")("what the third visit read");
    settlementFromTheFirstVisit("what the first visit read");
    expect(holder.value).toBe("what the third visit read");
  });

  it("drops a capture from a visit the subject left and came back to", () => {
    // The same round-trip through the other capture moment, because `settle` reads
    // the live pair and would otherwise re-derive the same too-weak comparison.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const capturedOnTheFirstVisit = holder.settle();
    holder.address(SUBJECT_TWO, "alpha", () => "seed");
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    capturedOnTheFirstVisit("what the first visit read");
    expect(holder.value).toBe("seed");
  });

  it("negative control: a re-address to the pair already held admits its publisher", () => {
    // The addressing advances on a MOVE and not on a re-render, so the two cases
    // above are about a subject that actually left. A holder that minted a new
    // addressing per call would refuse this and pass both of them.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const publisher = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    publisher("landed");
    expect(holder.value).toBe("landed");
  });

  it("negative control: the same settlement lands while the subject stands", () => {
    // Without this, "dropped" above would also be satisfied by a publisher that
    // never writes anything at all.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const settlement = holder.publisherFor(SUBJECT_ONE, "alpha");
    settlement("landed");
    expect(holder.value).toBe("landed");
  });

  it("applies the function form against the value held now, not the one closed over", () => {
    const holder = new SubjectScopedHolder<readonly string[]>();
    holder.address(SUBJECT_ONE, "alpha", () => []);
    const appendFirst = holder.publisherFor(SUBJECT_ONE, "alpha");
    const appendSecond = holder.publisherFor(SUBJECT_ONE, "alpha");
    appendFirst((previous) => [...previous, "first"]);
    appendSecond((previous) => [...previous, "second"]);
    expect(holder.value).toStrictEqual(["first", "second"]);
  });

  it("settle captures the subject standing when it is CALLED", () => {
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const capturedEarly = holder.settle();
    holder.address(SUBJECT_TWO, "alpha", () => "seed");
    const capturedLate = holder.settle();
    capturedEarly("from the subject that left");
    expect(holder.value).toBe("seed");
    capturedLate("from the subject on screen");
    expect(holder.value).toBe("from the subject on screen");
  });

  it("a capture taken before any address publishes nowhere rather than throwing", () => {
    const holder = new SubjectScopedHolder<string>();
    const beforeAnySubject = holder.settle();
    expect(() => {
      beforeAnySubject("nothing was ever addressed");
    }).not.toThrow();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    expect(holder.value).toBe("seed");
  });

  it("reading before an address is a composition error and says so", () => {
    const holder = new SubjectScopedHolder<string>();
    expect(() => holder.value).toThrow(/before it was addressed/);
  });

  it("wakes nobody for a publish that changes nothing", () => {
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    let wakes = 0;
    holder.subscribe(() => {
      wakes += 1;
    });
    holder.publisherFor(SUBJECT_ONE, "alpha")("seed");
    expect(wakes).toBe(0);
    // Negative control: the same subscription does wake for a real change.
    holder.publisherFor(SUBJECT_ONE, "alpha")("changed");
    expect(wakes).toBe(1);
  });
});

describe("useSubjectScopedState — no frame carries the previous subject", () => {
  it("re-addresses within the render, so the stale pair is never painted", () => {
    const log = new FrameLog();
    let publishInto: (next: string) => void = () => {};
    const view = render(
      <HolderProbe
        subject={SUBJECT_ONE}
        probeKey="alpha"
        log={log}
        onReady={(publish) => {
          publishInto = publish;
        }}
      />,
    );
    act(() => {
      publishInto("alpha's answer");
    });
    expect(log.painted("alpha", "alpha's answer")).toBe(true);
    const rendersBeforeMove = log.renderCount;

    view.rerender(<HolderProbe subject={SUBJECT_ONE} probeKey="beta" log={log} />);

    expect(log.painted("beta", "alpha's answer")).toBe(false);
    expect(log.frames.at(-1)).toStrictEqual({ key: "beta", value: "seed" });
    // One pass, not two: the holder is addressed before the value is read, so React
    // never has a render to discard.
    expect(log.renderCount).toBe(rendersBeforeMove + 1);
  });

  it("negative control: the effect-reset shape paints the previous subject's answer", () => {
    // The exact script above, against the code this module replaced. Both claims
    // above fail here, which is what makes them claims about the holder.
    const log = new FrameLog();
    let publishInto: (next: string) => void = () => {};
    const view = render(
      <EffectResetProbe
        subject={SUBJECT_ONE}
        probeKey="alpha"
        log={log}
        onReady={(publish) => {
          publishInto = publish;
        }}
      />,
    );
    act(() => {
      publishInto("alpha's answer");
    });
    act(() => {
      view.rerender(<EffectResetProbe subject={SUBJECT_ONE} probeKey="beta" log={log} />);
    });
    expect(log.painted("beta", "alpha's answer")).toBe(true);
  });

  it("keeps the value across a re-render that changes nothing about the subject", () => {
    const log = new FrameLog();
    let publishInto: (next: string) => void = () => {};
    const view = render(
      <HolderProbe
        subject={SUBJECT_ONE}
        probeKey="alpha"
        log={log}
        onReady={(publish) => {
          publishInto = publish;
        }}
      />,
    );
    act(() => {
      publishInto("alpha's answer");
    });
    view.rerender(<HolderProbe subject={SUBJECT_ONE} probeKey="alpha" log={log} />);
    expect(log.frames.at(-1)).toStrictEqual({ key: "alpha", value: "alpha's answer" });
  });

  it("drops a settlement whose subject moved, and lands one whose subject stood", () => {
    const log = new FrameLog();
    let capture: () => (next: string) => void = () => () => {};
    const view = render(
      <HolderProbe
        subject={SUBJECT_ONE}
        probeKey="alpha"
        log={log}
        onReady={(_publish, settle) => {
          capture = settle;
        }}
      />,
    );
    const settlementForAlpha = capture();
    view.rerender(<HolderProbe subject={SUBJECT_ONE} probeKey="beta" log={log} />);
    act(() => {
      settlementForAlpha("alpha's late answer");
    });
    expect(log.frames.at(-1)).toStrictEqual({ key: "beta", value: "seed" });

    const settlementForBeta = capture();
    act(() => {
      settlementForBeta("beta's answer");
    });
    expect(log.frames.at(-1)).toStrictEqual({ key: "beta", value: "beta's answer" });
  });

  it("drops a settlement from a route round-trip back to the key it left", () => {
    // The same defect through the hook, which is where it is reachable: a pane on
    // session s1 routed to s2 and back re-seeds and dispatches a fresh read, and the
    // FIRST visit's reply then lands last.
    const log = new FrameLog();
    let capture: () => (next: string) => void = () => () => {};
    const record = (
      _publish: (next: string) => void,
      settle: () => (next: string) => void,
    ): void => {
      capture = settle;
    };
    const view = render(
      <HolderProbe subject={SUBJECT_ONE} probeKey="alpha" log={log} onReady={record} />,
    );
    const settlementFromTheFirstVisit = capture();
    view.rerender(<HolderProbe subject={SUBJECT_ONE} probeKey="beta" log={log} onReady={record} />);
    view.rerender(
      <HolderProbe subject={SUBJECT_ONE} probeKey="alpha" log={log} onReady={record} />,
    );
    act(() => {
      settlementFromTheFirstVisit("the first visit's late answer");
    });
    expect(log.frames.at(-1)).toStrictEqual({ key: "alpha", value: "seed" });

    // Negative control: the visit on screen still settles, so the claim above is
    // about which visit answered rather than about a publisher that never writes.
    const settlementFromTheVisitOnScreen = capture();
    act(() => {
      settlementFromTheVisitOnScreen("the answer this visit read");
    });
    expect(log.frames.at(-1)).toStrictEqual({ key: "alpha", value: "the answer this visit read" });
  });

  it("holds nothing across mounts: a remount is a fresh subject with a fresh seed", () => {
    const log = new FrameLog();
    let publishInto: (next: string) => void = () => {};
    const first = render(
      <HolderProbe
        subject={SUBJECT_ONE}
        probeKey="alpha"
        log={log}
        onReady={(publish) => {
          publishInto = publish;
        }}
      />,
    );
    act(() => {
      publishInto("alpha's answer");
    });
    first.unmount();
    render(<HolderProbe subject={SUBJECT_ONE} probeKey="alpha" log={log} />);
    expect(log.frames.at(-1)).toStrictEqual({ key: "alpha", value: "seed" });
  });

  it("treats an absent key as its own subject, not as a string", () => {
    const log = new FrameLog();
    let publishInto: (next: string) => void = () => {};
    const view = render(
      <HolderProbe
        subject={SUBJECT_ONE}
        probeKey={undefined}
        log={log}
        onReady={(publish) => {
          publishInto = publish;
        }}
      />,
    );
    act(() => {
      publishInto("answered while addressed at nothing");
    });
    view.rerender(<HolderProbe subject={SUBJECT_ONE} probeKey="alpha" log={log} />);
    expect(log.frames.at(-1)).toStrictEqual({ key: "alpha", value: "seed" });
  });
});
