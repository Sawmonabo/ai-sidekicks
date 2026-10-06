// What the hook promises about frames and about which visit a publisher writes into.
//
// The rule itself (addressing, epoch, late settlement) is driven with no renderer in
// `lib/subject-scoped/holder.test.ts`. This file needs a tree: which frames a re-address paints,
// and what a render React parked leaves the visit on screen holding.
//
// Renders are counted because the guarantee is that the pass that first sees a new subject
// already reads its own seed: a holder that reached the same value by discarding a pass would
// satisfy every value assertion and cost a frame per re-address.

import { act, render } from "@testing-library/react";
import { Suspense, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { SUBJECT_ONE, SUBJECT_TWO } from "#test/helpers/subject-fixtures.js";
import { DiscardedRenderValueProbe } from "./DiscardedRenderValueProbe.test-support.js";
import { driveAbandonedPass } from "./subject-scoped-hooks.test-support.js";
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
  readonly onReady?: (publish: (next: string) => void) => void;
}

/** The holder under test, driven through the public hook. */
function HolderProbe(props: ProbeProps): ReactElement {
  const { value, publish } = useSubjectScopedState<string>(
    props.subject,
    props.probeKey,
    () => "seed",
  );
  props.log.record({ key: props.probeKey, value });
  props.onReady?.(publish);
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
});

/** The first publisher each subject's render handed out, so a late call goes through it. */
class CapturedPublishers<TValue> {
  readonly #bySubject = new Map<object, (next: TValue) => void>();

  public readonly record = (subject: object, publish: (next: TValue) => void): void => {
    if (!this.#bySubject.has(subject)) {
      this.#bySubject.set(subject, publish);
    }
  };

  public from(subject: object): (next: TValue) => void {
    const publish = this.#bySubject.get(subject);
    if (publish === undefined) {
      throw new Error("No render addressed at that subject handed out a publisher");
    }
    return publish;
  }
}

describe("useSubjectScopedState — a parked pass leaves the visit on screen alone", () => {
  /** The value probe driven through one committed visit, one parked pass, and back. */
  async function driveValueCase(): Promise<{
    readonly text: () => string | null;
    readonly publishers: CapturedPublishers<string>;
    readonly seedings: () => number;
  }> {
    const publishers = new CapturedPublishers<string>();
    let seedings = 0;
    const view = await driveAbandonedPass<object>(
      (subject, suspendOn) => (
        <Suspense fallback={<p>the pass that was parked</p>}>
          <DiscardedRenderValueProbe
            subject={subject}
            suspendOn={suspendOn}
            onSeed={() => {
              seedings += 1;
            }}
            onReady={(publish) => {
              publishers.record(subject, publish);
            }}
          />
        </Suspense>
      ),
      SUBJECT_ONE,
      SUBJECT_TWO,
    );
    // The parked pass really ran: it addressed the other subject, and addressing seeds.
    expect(seedings).toBeGreaterThanOrEqual(2);
    return { text: () => view.container.textContent, publishers, seedings: () => seedings };
  }

  const WHAT_THE_VISIT_ON_SCREEN_READ = "what the visit on screen read";

  it("settles through the publisher the component has been holding all along", async () => {
    const discardedRender = await driveValueCase();
    act(() => {
      discardedRender.publishers.from(SUBJECT_ONE)(WHAT_THE_VISIT_ON_SCREEN_READ);
    });

    expect(discardedRender.text()).toBe(WHAT_THE_VISIT_ON_SCREEN_READ);
    // Two addressings, not three: the parked pass proposed one and never committed it, so the
    // render back at the subject on screen found the committed addressing right and re-seeded
    // nothing.
    expect(discardedRender.seedings()).toBe(2);
  });

  it("refuses the settlement a pass that never committed handed out", async () => {
    // The parked pass handed its caller a publisher naming an addressing no frame carried, and
    // admitting it would write another subject's answer into the visit on screen.
    const discardedRender = await driveValueCase();
    act(() => {
      discardedRender.publishers.from(SUBJECT_TWO)("what a pass nobody saw read");
    });

    expect(discardedRender.text()).toBe("seed");

    // The visit on screen still settles, so the claim is about which pass answered.
    act(() => {
      discardedRender.publishers.from(SUBJECT_ONE)(WHAT_THE_VISIT_ON_SCREEN_READ);
    });
    expect(discardedRender.text()).toBe(WHAT_THE_VISIT_ON_SCREEN_READ);
  });
});
