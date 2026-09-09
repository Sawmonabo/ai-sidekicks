// A render React parks and never commits changes nothing about the visit on screen.
//
// The sibling of `subject-scoped-dropped-pass.test.tsx`, and the difference between
// the two files is the difference between the two discards. There, React retries the
// pass: the component is re-invoked, every hook cell is rebuilt, and the question is
// what a MEMO may be keyed on. Here the pass is parked and then superseded — a
// transition that suspends on a promise nothing resolves, which is the shape a slow
// route change or an interrupted concurrent render really has — and the question is
// what the HOLDER may do while it is pending.
//
// THE ANSWER THIS FILE IS ABOUT: nothing. The tree on screen is still painted, still
// reading, and still being settled into by calls dispatched before the parked pass
// began. An addressing that retired the committed one as it was minted took all three
// away — the publisher the surface holds started refusing every settlement, the value
// it had already been given was replaced by a seed for a subject nothing painted, and
// for a resource the pass had opened a connection no commit would ever reach.
//
// Every claim is paired with a NEGATIVE CONTROL driving the REAL holder in the
// arrangement this replaced: `address` and `commit` in the same breath, from the
// render body. Without it, "the visit on screen survived" would be a sentence about a
// test — a holder that never re-addressed at all would satisfy it too.

import { act, render } from "@testing-library/react";
import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { describe, expect, it } from "vitest";

import { driveAbandonedPass } from "./subject-scoped-drivers.test-support.js";
import {
  SUBJECT_ONE,
  SUBJECT_TWO,
  type NamedFixtureSubject,
} from "./subject-fixtures.test-support.js";
import { SubjectScopedHolder } from "./subject-scoped-holder.js";
import { ResourceDetourProbe } from "./ResourceDetourProbe.test-support.js";
import { ValueDetourProbe } from "./ValueDetourProbe.test-support.js";
import {
  DETOUR_KEY,
  type ResourceProbeProps,
  type ValueProbeProps,
} from "./subject-scoped-probes.test-support.js";
import {
  DISCARDED_SUBJECT,
  ResourceLedger,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./subject-scoped-resource.test-support.js";

/** What the surface reads once the visit on screen has been settled into. */
const WHAT_THE_VISIT_ON_SCREEN_READ = "what the visit on screen read";

/**
 * The first publisher each subject's render handed out, so a late call can be made
 * through the one a given pass really gave its caller.
 *
 * FIRST rather than last: the claim is about the publisher the tree on screen has been
 * holding since before the parked pass began, and about the one the parked pass handed
 * out and nothing ever committed. A record of the newest would name neither.
 */
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

/**
 * The arrangement this replaced: an addressing confirmed by the render that made it.
 *
 * Not a stand-in for the hook — it drives the real holder, with the real memo key,
 * and collapses the one thing this fix separated: `commit` runs in the render body,
 * so a pass that never becomes a frame retires the visit that is one.
 */
function RenderTimeRetireValueProbe(props: ValueProbeProps): ReactElement {
  const [holder] = useState(() => new SubjectScopedHolder<string>());
  holder.address(props.subject, DETOUR_KEY, () => {
    props.onSeed();
    return "seed";
  });
  holder.commit(props.subject, DETOUR_KEY);
  const subscribe = useCallback((onChange: () => void) => holder.subscribe(onChange), [holder]);
  const read = useCallback(() => holder.value, [holder]);
  const value = useSyncExternalStore(subscribe, read, read);
  const publish = useMemo(
    () => holder.publisherFor(props.subject, DETOUR_KEY),
    [holder, props.subject, holder.addressing],
  );
  props.onReady(publish);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>{value}</output>;
}

/**
 * The same arrangement for a resource: the holder retires at render time and an
 * effect owns the disposal, which is what the two frame subsystems ran.
 */
function RenderTimeRetireResourceProbe(props: ResourceProbeProps): ReactElement {
  const { ledger } = props;
  const [holder] = useState(() => new SubjectScopedHolder<OpenResource>());
  holder.address(props.subject, undefined, () => ledger.open(props.subject.name));
  holder.commit(props.subject, undefined);
  const subscribe = useCallback((onChange: () => void) => holder.subscribe(onChange), [holder]);
  const read = useCallback(() => holder.value, [holder]);
  const value = useSyncExternalStore(subscribe, read, read);
  const publish = useMemo(
    () => holder.publisherFor(props.subject, undefined),
    [holder, props.subject, holder.addressing],
  );
  useEffect(() => {
    return () => {
      ledger.close(value);
    };
  }, [ledger, value]);
  props.onReady(publish);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>{value.name}</output>;
}

/** What both value cases drive, and what each is left holding. */
async function driveValueCase(Probe: (props: ValueProbeProps) => ReactElement): Promise<{
  readonly text: () => string | null;
  readonly publishers: CapturedPublishers<string>;
  readonly seedings: () => number;
}> {
  const publishers = new CapturedPublishers<string>();
  let seedings = 0;
  const view = await driveAbandonedPass<object>(
    (subject, suspendOn) => (
      <Suspense fallback={<p>the pass that was parked</p>}>
        <Probe
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

/** What both resource cases drive, and what each is left holding. */
async function driveResourceCase(
  Probe: (props: ResourceProbeProps) => ReactElement,
): Promise<{ readonly ledger: ResourceLedger; readonly unmount: () => void }> {
  const ledger = new ResourceLedger();
  const view = await driveAbandonedPass<NamedFixtureSubject>(
    (subject, suspendOn) => (
      <Suspense fallback={<p>the pass that was parked</p>}>
        <Probe subject={subject} suspendOn={suspendOn} ledger={ledger} onReady={() => {}} />
      </Suspense>
    ),
    SETTLED_SUBJECT,
    DISCARDED_SUBJECT,
  );
  // The parked pass really ran: it opened a resource at the other subject.
  expect(ledger.opened).toContain(DISCARDED_SUBJECT.name);
  return { ledger, unmount: () => view.unmount() };
}

describe("useSubjectScopedState — a parked pass leaves the visit on screen alone", () => {
  it("settles through the publisher the surface has been holding all along", async () => {
    const detour = await driveValueCase(ValueDetourProbe);
    act(() => {
      detour.publishers.from(SUBJECT_ONE)(WHAT_THE_VISIT_ON_SCREEN_READ);
    });

    expect(detour.text()).toBe(WHAT_THE_VISIT_ON_SCREEN_READ);
    // TWO addressings, not three: the parked pass proposed one and never committed
    // it, so the render back at the subject on screen found the committed addressing
    // already right and re-seeded nothing.
    expect(detour.seedings()).toBe(2);
  });

  it("negative control: retiring at render time drops that settlement and re-seeds", async () => {
    // The identical script against the arrangement this replaced. The parked pass
    // retired the visit on screen as it addressed, so the publisher that visit handed
    // out names an addressing nothing holds and its answer is refused — and the value
    // the surface reads is a seed produced for a pass that never became a frame.
    const detour = await driveValueCase(RenderTimeRetireValueProbe);
    act(() => {
      detour.publishers.from(SUBJECT_ONE)(WHAT_THE_VISIT_ON_SCREEN_READ);
    });

    expect(detour.text()).toBe("seed");
    expect(detour.seedings()).toBe(3);
  });

  it("refuses the settlement a pass that never committed handed out", async () => {
    // The other direction, and the reason a proposal is not simply left standing: the
    // parked pass really handed its caller a publisher, and that publisher names an
    // addressing no frame ever carried. Admitting it would write another subject's
    // answer into the visit on screen.
    const detour = await driveValueCase(ValueDetourProbe);
    act(() => {
      detour.publishers.from(SUBJECT_TWO)("what a pass nobody saw read");
    });

    expect(detour.text()).toBe("seed");

    // Negative control on that refusal: the visit on screen still settles, so the
    // claim is about which pass answered rather than about a holder that refuses
    // everything.
    act(() => {
      detour.publishers.from(SUBJECT_ONE)(WHAT_THE_VISIT_ON_SCREEN_READ);
    });
    expect(detour.text()).toBe(WHAT_THE_VISIT_ON_SCREEN_READ);
  });
});

describe("useSubjectScopedResource — a parked pass's resource is closed, and only it", () => {
  it("closes what the parked pass opened and leaves the one on screen alone", async () => {
    const resources = await driveResourceCase(ResourceDetourProbe);

    expect(resources.ledger.opened).toStrictEqual(["settled", "discarded"]);
    expect(resources.ledger.closed).toStrictEqual(["discarded"]);

    // And the resource on screen was never retired, so nothing was opened to cover
    // for one that had been: it is closed once, at the mount's end.
    resources.unmount();
    expect(resources.ledger.closed).toStrictEqual(["discarded", "settled"]);
  });

  it("negative control: retiring at render time leaks that resource and re-opens", async () => {
    // The identical script against the shape the two frame subsystems ran. The parked
    // pass's connection is installed nowhere and closed by nothing, and the connection
    // the surface was reading through is retired and opened again underneath it.
    const resources = await driveResourceCase(RenderTimeRetireResourceProbe);

    expect(resources.ledger.opened).toStrictEqual(["settled", "discarded", "settled"]);
    expect(resources.ledger.closed).toStrictEqual(["settled"]);

    resources.unmount();
    expect(resources.ledger.closed).not.toContain("discarded");
  });

  it("closes a parked pass's resource where the mount ends before any later render", async () => {
    // The one bound the two supersession paths do not reach: a surface whose parked
    // pass is followed by no render at all because the surface itself went away. The
    // proposal is reachable through nothing else, so the mount's end is its last
    // moment.
    const ledger = new ResourceLedger();
    const treeAt = (
      subject: NamedFixtureSubject,
      suspendOn: Promise<void> | undefined,
    ): ReactElement => (
      <Suspense fallback={<p>the pass that was parked</p>}>
        <ResourceDetourProbe
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
