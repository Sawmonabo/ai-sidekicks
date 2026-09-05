// What the hook promises about FRAMES, and what the shape it replaced actually did.
//
// The hook half of `subject-scoped-state.ts`. The class half — the addressing rule,
// the epoch, and what a late settlement does — is drivable with no renderer at all
// and lives in `subject-scoped-state.holder.test.ts`; what needs a tree is the claim
// this file is about: which frames a re-address paints, and which render a publisher
// captured at is the one it writes into.
//
// The publisher's own claim — that it names the visit on screen even after a render
// React dropped moved the addressing underneath it — is a third subject and lives in
// `subject-scoped-dropped-pass.test.tsx`, beside the resource hook's half of it.
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

import { SUBJECT_ONE } from "./subject-fixtures.test-support.js";
import { useSubjectScopedState } from "./subject-scoped-state.js";

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
