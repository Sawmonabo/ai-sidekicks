// A resource the holder drops is closed once, whichever render dropped it.
//
// Two drivers reach a render that ran and never committed: a state update during the render body
// (React discards that pass and re-invokes the component), and a transition that suspends and is
// superseded (parked). Closes are counted
// by name, since a hook that closed everything twice would satisfy a bare "was closed".

import { act, render } from "@testing-library/react";
import { StrictMode, Suspense, useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import type { NamedFixtureSubject } from "@test/helpers/subject-fixtures.js";
import { DiscardedRenderResourceProbe } from "./DiscardedRenderResourceProbe.test-support.js";
import { driveAbandonedPass } from "./subject-scoped-hooks.test-support.js";
import { useSubjectScopedResource } from "./useSubjectScopedResource.js";
import {
  DISCARDED_SUBJECT,
  ResourceOpenCloseLog,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./useSubjectScopedResource.test-support.js";

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
    expect(windowTripwires.firingCount("unheld-resource")).toBe(1);

    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "opened too late", "settled"]);
  });
});

describe("useSubjectScopedResource — a resource its own close ended is re-minted", () => {
  /** A caller whose disposal is terminal, like the preview pane's geometry publisher. */
  function TerminalCloseProbe(props: {
    readonly subject: NamedFixtureSubject;
    readonly ledger: ResourceOpenCloseLog;
    readonly onResource: (resource: OpenResource) => void;
  }): ReactElement {
    const { ledger } = props;
    const { value } = useSubjectScopedResource<OpenResource>(
      props.subject,
      undefined,
      () => ledger.open(props.subject.name),
      { dispose: ledger.close, isClosed: ledger.isClosed },
    );
    props.onResource(value);
    return <output>{value.name}</output>;
  }

  it("holds a live resource after React's double-mount, not the one it disposed", () => {
    // The double mount runs the committed cleanup and then the effect again against the value
    // that cleanup closed; the subject must hold something usable.
    const ledger = new ResourceOpenCloseLog();
    const seen: OpenResource[] = [];
    render(
      <StrictMode>
        <TerminalCloseProbe
          subject={SETTLED_SUBJECT}
          ledger={ledger}
          onResource={(resource) => seen.push(resource)}
        />
      </StrictMode>,
    );

    const held = seen.at(-1);
    if (held === undefined) {
      throw new Error("the probe rendered no resource at all");
    }
    expect(ledger.isClosed(held)).toBe(false);
    // Opened twice, closed once: the replacement, and the corpse it replaced. The corpse
    // reaches the holder's disposal as an ordinary replaced value, and a second `dispose()`
    // is what a terminal close refuses.
    expect(ledger.opened).toStrictEqual(["settled", "settled"]);
    expect(ledger.closed).toStrictEqual(["settled"]);
  });
});

describe("useSubjectScopedResource — a disposal minted per render is not a lifetime", () => {
  it("closes nothing on a rerender that only minted a fresh disposal", () => {
    // If `close` sat in the lifetime effect's dependency list, an unrelated rerender would run
    // that effect's cleanup and close the resource the frame on screen still reads.
    const ledger = new ResourceOpenCloseLog();
    const resources: OpenResource[] = [];
    function FreshCloseProbe(props: { readonly pass: number }): ReactElement {
      const { value } = useSubjectScopedResource<OpenResource>(
        DISCARDED_SUBJECT,
        undefined,
        () => ledger.open(DISCARDED_SUBJECT.name),
        {
          release: (resource) => {
            ledger.close({ name: `${resource.name} closed by pass ${String(props.pass)}` });
          },
        },
      );
      resources.push(value);
      return <output>{value.name}</output>;
    }
    const view = render(<FreshCloseProbe pass={1} />);
    view.rerender(<FreshCloseProbe pass={2} />);
    view.rerender(<FreshCloseProbe pass={3} />);

    expect(ledger.opened).toStrictEqual(["discarded"]);
    expect(ledger.closed).toStrictEqual([]);
    // The component still reads through the resource it opened, not a replacement minted to
    // cover for one closed underneath it.
    expect(new Set(resources).size).toBe(1);
  });
});

describe("useSubjectScopedResource — a render that never became a frame", () => {
  it("closes what a parked pass opened and leaves the one on screen alone", async () => {
    const ledger = new ResourceOpenCloseLog();
    const view = await driveAbandonedPass<NamedFixtureSubject>(
      (subject, suspendOn) => (
        <Suspense fallback={<p>the pass that was parked</p>}>
          <DiscardedRenderResourceProbe
            subject={subject}
            suspendOn={suspendOn}
            ledger={ledger}
            onReady={() => {}}
          />
        </Suspense>
      ),
      SETTLED_SUBJECT,
      DISCARDED_SUBJECT,
    );

    expect(ledger.opened).toStrictEqual(["settled", "discarded"]);
    expect(ledger.closed).toStrictEqual(["discarded"]);

    // The resource on screen was never retired, so nothing was opened to cover for it; it is
    // closed once, at the mount's end.
    view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded", "settled"]);
  });

  it("closes a parked pass's resource where the mount ends before any later render", async () => {
    // The component goes away with no render after the parked pass. The proposal is reachable
    // through nothing else, so the mount's end is its last moment.
    const ledger = new ResourceOpenCloseLog();
    const treeAt = (
      subject: NamedFixtureSubject,
      suspendOn: Promise<void> | undefined,
    ): ReactElement => (
      <Suspense fallback={<p>the pass that was parked</p>}>
        <DiscardedRenderResourceProbe
          subject={subject}
          suspendOn={suspendOn}
          ledger={ledger}
          onReady={() => {}}
        />
      </Suspense>
    );
    const view = render(treeAt(SETTLED_SUBJECT, undefined));
    const parked = new Promise<void>(() => {});
    await act(async () => {
      view.rerender(treeAt(DISCARDED_SUBJECT, parked));
    });

    view.unmount();

    expect(ledger.opened).toStrictEqual(["settled", "discarded"]);
    expect(new Set(ledger.closed)).toStrictEqual(new Set(["settled", "discarded"]));
    expect(ledger.closed).toHaveLength(2);
  });
});
