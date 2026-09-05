// A resource the holder drops is closed once, whichever render dropped it.
//
// The case this module exists for is the render REACT THROWS AWAY, and it is driven
// here the one way that is deterministic rather than timing-dependent: a state update
// issued during the render body. React discards that pass and re-invokes the component
// with the new state, which is exactly the shape the module describes — a pass that
// really ran, really opened a resource, and never committed.
//
// The publisher's own claim across a dropped pass — a resource published into a visit
// that is over is opened and closed by nothing — is a third subject and lives in
// `subject-scoped-dropped-pass.test.tsx`, beside the value hook's half of it.
//
// Every claim is paired with a NEGATIVE CONTROL driving the shape this replaced — the
// plain holder with an effect that owns disposal — over the identical script. Without
// it, "the discarded pass's resource was closed" would be a sentence about a test: a
// hook that closed everything twice would satisfy it too, which is why the closes are
// counted by name rather than merely looked for.

import { act, render } from "@testing-library/react";
import { useEffect, useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../core/tripwires.js";
import { useSubjectScopedResource } from "./subject-scoped-resource.js";
import type { NamedFixtureSubject } from "./subject-fixtures.test-support.js";
import {
  DISCARDED_SUBJECT,
  ResourceLedger,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./subject-scoped-resource.test-support.js";
import { useSubjectScopedState } from "./subject-scoped-state.js";

// Tripwires throw in a development build, so the one this file drives would reach the
// caller's settlement as an escaping throw rather than as the record under test. The
// recording arm is the one asserted, as it is in `subject-scoped-holder.test.ts`.
const THROW_ON_REPORT_BEFORE_THE_SUITE = import.meta.env.DEV;

beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.setThrowOnReport(THROW_ON_REPORT_BEFORE_THE_SUITE);
  consoleTripwires.reset();
});

interface DiscardProbeProps {
  /** The subject the pass React throws away is addressed at. */
  readonly firstPassSubject: NamedFixtureSubject;
  /** The subject the pass that actually commits is addressed at. */
  readonly settledSubject: NamedFixtureSubject;
  readonly ledger: ResourceLedger;
}

/**
 * A component whose first render pass is discarded, at a different subject.
 *
 * The `setPass` call is a render-phase update, which React answers by discarding this
 * pass's output and re-invoking the component. The holder is an external object, so
 * the discarded pass's `open` really ran and its resource was really installed —
 * which is the whole reachability question.
 */
function DiscardedRenderProbe(props: DiscardProbeProps): ReactElement {
  const [pass, setPass] = useState(0);
  const subject = pass === 0 ? props.firstPassSubject : props.settledSubject;
  const { value } = useSubjectScopedResource<OpenResource>(
    subject,
    undefined,
    () => props.ledger.open(subject.name),
    props.ledger.close,
  );
  if (pass === 0) {
    setPass(1);
  }
  return <output>{value.name}</output>;
}

/**
 * The shape this module replaced: the plain holder, disposal owned by an effect.
 *
 * Not a stand-in for the hook — it is the code the two frame subsystems ran before
 * this module existed, kept only so the claims above it are shown to discriminate.
 */
function EffectOnlyDisposalProbe(props: DiscardProbeProps): ReactElement {
  const [pass, setPass] = useState(0);
  const subject = pass === 0 ? props.firstPassSubject : props.settledSubject;
  const { value } = useSubjectScopedState<OpenResource>(subject, undefined, () =>
    props.ledger.open(subject.name),
  );
  const { ledger } = props;
  useEffect(() => {
    return () => {
      ledger.close(value);
    };
  }, [ledger, value]);
  if (pass === 0) {
    setPass(1);
  }
  return <output>{value.name}</output>;
}

interface SwapProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly ledger: ResourceLedger;
  readonly onReady?: (publish: (next: OpenResource) => void) => void;
}

function SwapProbe(props: SwapProbeProps): ReactElement {
  const { value, publish } = useSubjectScopedResource<OpenResource>(
    props.subject,
    undefined,
    () => props.ledger.open(props.subject.name),
    props.ledger.close,
  );
  props.onReady?.(publish);
  return <output>{value.name}</output>;
}
describe("useSubjectScopedResource — a render React discarded leaves nothing open", () => {
  it("closes the resource the discarded pass opened, and only that one", () => {
    const ledger = new ResourceLedger();
    const view = render(
      <DiscardedRenderProbe
        firstPassSubject={DISCARDED_SUBJECT}
        settledSubject={SETTLED_SUBJECT}
        ledger={ledger}
      />,
    );

    expect(ledger.opened).toStrictEqual(["discarded", "settled"]);
    expect(ledger.closed).toStrictEqual(["discarded"]);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "settled"]);
  });

  it("negative control: the shape this replaced leaves the discarded pass's resource open", () => {
    // The identical script against the code the two frame subsystems ran before this
    // module existed. Its effect never closed over the discarded pass's resource, so
    // nothing ever closes it — which is the defect, and the reason the claim above is
    // about this hook rather than about the script.
    const ledger = new ResourceLedger();
    const view = render(
      <EffectOnlyDisposalProbe
        firstPassSubject={DISCARDED_SUBJECT}
        settledSubject={SETTLED_SUBJECT}
        ledger={ledger}
      />,
    );

    expect(ledger.opened).toStrictEqual(["discarded", "settled"]);
    expect(ledger.closed).toStrictEqual([]);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["settled"]);
  });
});

describe("useSubjectScopedResource — a committed resource is closed once, by the effect", () => {
  it("closes the retired resource when the subject moves, and not twice", () => {
    // The committed arm: this resource IS the one a live effect holds, so closing it
    // during the render that replaces it would tear down what the frame on screen is
    // still reading through — and that render may itself be discarded.
    const ledger = new ResourceLedger();
    const view = render(<SwapProbe subject={DISCARDED_SUBJECT} ledger={ledger} />);
    expect(ledger.closed).toStrictEqual([]);

    view.rerender(<SwapProbe subject={SETTLED_SUBJECT} ledger={ledger} />);

    expect(ledger.opened).toStrictEqual(["discarded", "settled"]);
    expect(ledger.closed).toStrictEqual(["discarded"]);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "settled"]);
  });

  it("opens and closes nothing on a re-render that changes nothing about the subject", () => {
    // The control on every case above: a hook that opened per render would satisfy
    // them all, and one that closed per render would leave the window with nothing.
    const ledger = new ResourceLedger();
    const view = render(<SwapProbe subject={DISCARDED_SUBJECT} ledger={ledger} />);

    view.rerender(<SwapProbe subject={DISCARDED_SUBJECT} ledger={ledger} />);
    view.rerender(<SwapProbe subject={DISCARDED_SUBJECT} ledger={ledger} />);

    expect(ledger.opened).toStrictEqual(["discarded"]);
    expect(ledger.closed).toStrictEqual([]);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded"]);
  });

  it("closes a resource a caller published over, on the same terms", () => {
    // Publishing is how a window replaces a resource that has retired itself. The
    // replacement is held and disposed exactly as one the holder seeded — and this
    // is the control on the late-open case below: a hook that closed every published
    // resource would leave both live callers with none.
    const ledger = new ResourceLedger();
    let publishInto: (next: OpenResource) => void = () => {};
    const view = render(
      <SwapProbe
        subject={DISCARDED_SUBJECT}
        ledger={ledger}
        onReady={(publish) => {
          publishInto = publish;
        }}
      />,
    );
    act(() => {
      publishInto(ledger.open("published"));
    });

    expect(ledger.opened).toStrictEqual(["discarded", "published"]);
    expect(ledger.closed).toStrictEqual(["discarded"]);
    expect(consoleTripwires.totalFiringCount).toBe(0);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "published"]);
  });
});

describe("useSubjectScopedResource — two publishes before one commit", () => {
  it("closes the resource the second publish replaced, and leaves the committed one to the effect", () => {
    // The batched case: two direct settlements land in one event, so the first
    // replacement is installed and replaced again with no commit in between. No
    // effect ever closed over it and the re-addressing path never sees it — the
    // holder's own write is the last moment anything can reach it.
    const ledger = new ResourceLedger();
    let publishInto: (next: OpenResource) => void = () => {};
    const view = render(
      <SwapProbe
        subject={DISCARDED_SUBJECT}
        ledger={ledger}
        onReady={(publish) => {
          publishInto = publish;
        }}
      />,
    );

    act(() => {
      publishInto(ledger.open("published first"));
      publishInto(ledger.open("published second"));
    });

    expect(ledger.opened).toStrictEqual(["discarded", "published first", "published second"]);
    // The middle one is the whole case. The committed resource is closed AFTER it, by
    // the effect that was holding it — never during the publish, where the frame on
    // screen is still reading through it and the pass may yet be discarded.
    expect(ledger.closed).toStrictEqual(["published first", "discarded"]);
    expect(view.container.textContent).toBe("published second");

    // And the survivor is the one on screen, closed once, at the mount's end.
    view.unmount();
    expect(ledger.closed).toStrictEqual(["published first", "discarded", "published second"]);
  });

  it("negative control: a single publish closes nothing before its own commit", () => {
    // Without this, "the replaced resource was closed" would also be satisfied by a
    // hook that closed every published value — which would close the resource the
    // window just opened for the visit it is on.
    const ledger = new ResourceLedger();
    let publishInto: (next: OpenResource) => void = () => {};
    render(
      <SwapProbe
        subject={DISCARDED_SUBJECT}
        ledger={ledger}
        onReady={(publish) => {
          publishInto = publish;
        }}
      />,
    );
    const published = ledger.open("published once");

    act(() => {
      publishInto(published);
    });

    expect(ledger.closed).not.toContain("published once");
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });
});

describe("useSubjectScopedResource — an open that settles after the subject has moved", () => {
  it("closes the resource the late open produced, and installs nothing", () => {
    // A caller opens a connection for the visit on screen, the surface is
    // re-addressed while that open is in flight, and the settlement names a visit
    // that is over. Nothing installs it, so no commit and no effect will ever see it
    // — the holder's refusal is the resource's last reachable moment, which is why
    // this hook hands the holder its disposal rather than leaving a refusal a drop.
    const ledger = new ResourceLedger();
    let publishInto: (next: OpenResource) => void = () => {};
    const treeAt = (subject: NamedFixtureSubject): ReactElement => (
      <SwapProbe
        subject={subject}
        ledger={ledger}
        onReady={(publish) => {
          publishInto = publish;
        }}
      />
    );
    const view = render(treeAt(DISCARDED_SUBJECT));
    const settlementFromTheVisitThatEnded = publishInto;

    view.rerender(treeAt(SETTLED_SUBJECT));
    act(() => {
      settlementFromTheVisitThatEnded(ledger.open("opened too late"));
    });

    expect(ledger.opened).toStrictEqual(["discarded", "settled", "opened too late"]);
    expect(ledger.closed).toStrictEqual(["discarded", "opened too late"]);
    // And the surface goes on reading through the visit it is addressed at.
    expect(view.container.textContent).toBe("settled");
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "opened too late", "settled"]);
  });
});
