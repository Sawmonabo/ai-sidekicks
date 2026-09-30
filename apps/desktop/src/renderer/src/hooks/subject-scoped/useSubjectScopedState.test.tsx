// What the hook promises about frames, against the shape a plain `useState` reset gives.
//
// The rule itself (addressing, epoch, late settlement) is driven with no renderer in
// `subject-scoped-holder.test.ts`. This file needs a tree for which frames a re-address
// paints and which render a publisher captured at is the one it writes into. A publisher
// across a dropped pass is covered in `useSubjectScopedState.dropped-pass.test.tsx`.
//
// Each clean assertion has a negative control that drives a `useState` reset from an effect
// over the identical script and fails, since a holder that never re-addressed would pass
// "no frame carried the old subject" too. Renders are counted because the guarantee is that
// the pass that first sees a new subject already reads its own seed: a holder that reached
// the same value by discarding a pass would satisfy every value assertion and cost a frame
// per re-address.

import { act, render } from "@testing-library/react";
import { useEffect, useState, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { SUBJECT_ONE } from "@test/helpers/subject-fixtures.js";
import { useSubjectScopedState } from "./useSubjectScopedState.js";

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
 * Negative control: state reset from an effect.
 *
 * It implements the rule's opposite on purpose; a test that reimplemented the rule would
 * prove nothing.
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
    // One pass, not two: the holder is addressed before the value is read, so React has no
    // render to discard.
    expect(log.renderCount).toBe(rendersBeforeMove + 1);
  });

  it("negative control: the effect-reset shape paints the previous subject's answer", () => {
    // The script above against state reset from an effect; both claims above fail here.
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
    // A pane on session s1 routed to s2 and back re-seeds and dispatches a fresh read, and
    // the first visit's reply then lands last.
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

    // Negative control: the visit on screen still settles, so the claim is about which visit
    // answered.
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
