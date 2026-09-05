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
import { describe, expect, it } from "vitest";

import { useSubjectScopedResource } from "./subject-scoped-resource.js";
import type { NamedFixtureSubject } from "./subject-fixtures.test-support.js";
import {
  DISCARDED_SUBJECT,
  ResourceLedger,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./subject-scoped-resource.test-support.js";
import { useSubjectScopedState } from "./subject-scoped-state.js";

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
    // replacement is held and disposed exactly as one the holder seeded.
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

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "published"]);
  });
});
