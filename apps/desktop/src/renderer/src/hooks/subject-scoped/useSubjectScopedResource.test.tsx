// A resource the holder drops is closed once, whichever render dropped it.
//
// The render React throws away is driven with a state update during the render body: React
// discards that pass and re-invokes the component, so the pass really ran and really opened
// a resource without committing. The dropped and abandoned pass suites are
// `useSubjectScopedState.dropped-pass.test.tsx` and `.abandoned-pass.test.tsx`.
//
// Each claim has a negative control over the identical script (the plain holder with an
// effect that owns disposal). Closes are counted by name, since a hook that closed everything
// twice would satisfy a bare "was closed".

import { act, render } from "@testing-library/react";
import { useEffect, useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import { useSubjectScopedResource } from "./useSubjectScopedResource.js";
import type { NamedFixtureSubject } from "@test/helpers/subject-fixtures.js";
import {
  DISCARDED_SUBJECT,
  ResourceOpenCloseLog,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./useSubjectScopedResource.test-support.js";
import { useSubjectScopedState } from "./useSubjectScopedState.js";

// Tripwires throw in a development build, which would escape the caller's settlement; the
// recording arm is the one asserted, as in `subject-scoped-holder.test.ts`.
const THROW_ON_REPORT_BEFORE_THE_SUITE = import.meta.env.DEV;

beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

afterEach(() => {
  windowTripwires.setThrowOnReport(THROW_ON_REPORT_BEFORE_THE_SUITE);
  windowTripwires.reset();
});

interface DiscardProbeProps {
  /** The subject the pass React throws away is addressed at. */
  readonly firstPassSubject: NamedFixtureSubject;
  /** The subject the pass that actually commits is addressed at. */
  readonly settledSubject: NamedFixtureSubject;
  readonly ledger: ResourceOpenCloseLog;
}

/**
 * A component whose first render pass is discarded, at a different subject.
 *
 * The `setPass` call is a render-phase update: React discards this pass's output and
 * re-invokes the component, but the holder is external, so the discarded pass's `open`
 * really ran.
 */
function DiscardedRenderProbe(props: DiscardProbeProps): ReactElement {
  const [pass, setPass] = useState(0);
  const subject = pass === 0 ? props.firstPassSubject : props.settledSubject;
  const { value } = useSubjectScopedResource<OpenResource>(
    subject,
    undefined,
    () => props.ledger.open(subject.name),
    { release: props.ledger.close },
  );
  if (pass === 0) {
    setPass(1);
  }
  return <output>{value.name}</output>;
}

/**
 * Negative control: the plain holder with disposal owned by an effect.
 *
 * Its effect never closes over a discarded pass's resource, which shows the claims above
 * discriminate.
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
  readonly ledger: ResourceOpenCloseLog;
  readonly onReady?: (publish: (next: OpenResource) => void) => void;
}

function SwapProbe(props: SwapProbeProps): ReactElement {
  const { value, publish } = useSubjectScopedResource<OpenResource>(
    props.subject,
    undefined,
    () => props.ledger.open(props.subject.name),
    { release: props.ledger.close },
  );
  props.onReady?.(publish);
  return <output>{value.name}</output>;
}
describe("useSubjectScopedResource — a render React discarded leaves nothing open", () => {
  it("closes the resource the discarded pass opened, and only that one", () => {
    const ledger = new ResourceOpenCloseLog();
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
    // The same script against a plain holder whose effect owns disposal. That effect never
    // closed over the discarded pass's resource, so nothing closes it; this is what makes the
    // claim above about the hook and not about the script.
    const ledger = new ResourceOpenCloseLog();
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
    // This resource is the one a live effect holds; closing it during the render that
    // replaces it would tear down what the frame on screen still reads, and that render may
    // itself be discarded.
    const ledger = new ResourceOpenCloseLog();
    const view = render(<SwapProbe subject={DISCARDED_SUBJECT} ledger={ledger} />);
    expect(ledger.closed).toStrictEqual([]);

    view.rerender(<SwapProbe subject={SETTLED_SUBJECT} ledger={ledger} />);

    expect(ledger.opened).toStrictEqual(["discarded", "settled"]);
    expect(ledger.closed).toStrictEqual(["discarded"]);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "settled"]);
  });

  it("opens and closes nothing on a re-render that changes nothing about the subject", () => {
    // Control on every case above: a hook that opened per render would satisfy them all, and
    // one that closed per render would leave the window with nothing.
    const ledger = new ResourceOpenCloseLog();
    const view = render(<SwapProbe subject={DISCARDED_SUBJECT} ledger={ledger} />);

    view.rerender(<SwapProbe subject={DISCARDED_SUBJECT} ledger={ledger} />);
    view.rerender(<SwapProbe subject={DISCARDED_SUBJECT} ledger={ledger} />);

    expect(ledger.opened).toStrictEqual(["discarded"]);
    expect(ledger.closed).toStrictEqual([]);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded"]);
  });

  it("closes a resource a caller published over, on the same terms", () => {
    // Publishing replaces a resource that retired itself; the replacement is held and
    // disposed as one the holder seeded. Also the control on the late-open case below: a hook
    // that closed every published resource would leave both live callers with none.
    const ledger = new ResourceOpenCloseLog();
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
    expect(windowTripwires.totalFiringCount).toBe(0);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "published"]);
  });
});

describe("useSubjectScopedResource — two publishes before one commit", () => {
  it("closes the resource the second publish replaced, and leaves the committed one to the effect", () => {
    // Two direct settlements in one event: the first replacement is installed and replaced
    // with no commit in between, so no effect closed over it and the holder's own write is
    // the last moment anything reaches it.
    const ledger = new ResourceOpenCloseLog();
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
    // The committed resource closes after it, by the effect holding it; never during the
    // publish, where the frame on screen still reads it and the pass may yet be discarded.
    expect(ledger.closed).toStrictEqual(["published first", "discarded"]);
    expect(view.container.textContent).toBe("published second");

    // The survivor is on screen and closed once, at the mount's end.
    view.unmount();
    expect(ledger.closed).toStrictEqual(["published first", "discarded", "published second"]);
  });

  it("negative control: a single publish closes nothing before its own commit", () => {
    // Control: a hook that closed every published value would also satisfy the case above,
    // and would close the resource the window just opened for the visit it is on.
    const ledger = new ResourceOpenCloseLog();
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
    expect(windowTripwires.totalFiringCount).toBe(0);
  });
});

describe("useSubjectScopedResource — an open that settles after the subject has moved", () => {
  it("closes the resource the late open produced, and installs nothing", () => {
    // The component is re-addressed while an open is in flight, and the settlement names a
    // visit that is over. No commit or effect will see the resource, so the holder's refusal
    // is its last reachable moment.
    const ledger = new ResourceOpenCloseLog();
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
    // The component goes on reading through the visit it is addressed at.
    expect(view.container.textContent).toBe("settled");
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "opened too late", "settled"]);
  });
});
