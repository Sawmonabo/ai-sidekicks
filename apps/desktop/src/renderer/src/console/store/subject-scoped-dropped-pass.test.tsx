// A publisher outlives no visit, including one a render React DROPPED.
//
// Both subject hooks hand a caller a `publish` captured at render, and both memoize
// it. The question this file is about is what that memo may be keyed on, and the
// answer the pair alone gives is wrong in one direction: a surface routed away and
// back is at the same pair on two different visits, so a pass that re-addressed and
// was then thrown away leaves the committed visit's publisher naming a visit that is
// over. It publishes NOWHERE, silently — and where the value is a resource, it takes
// whatever the caller had just opened for it down with it, because the holder's
// discard callback runs from `address` and never from a publish.
//
// WHICH DISCARD, MEASURED RATHER THAN ASSUMED. The probe in
// `subject-scoped-resource.test.tsx` sets state during the render body, which React
// answers by re-invoking the component and REUSING the hook cells that pass built —
// so a memo whose dependencies moved in the dropped pass IS recomputed, and nothing
// goes stale. That is the right driver for the claim it drives, which is about the
// resource the pass opened. It is the wrong one here. A pass that SUSPENDS is a
// work-in-progress fiber React throws away: the next render rebuilds every hook from
// the last COMMITTED one, which is the arrangement that leaves a memo comparing this
// visit's dependencies against a visit two addressings ago. That is the concurrent
// discard `subject-scoped-resource.ts`'s header names, driven the one way that is
// deterministic rather than timing-dependent.
//
// Both claims are paired with a NEGATIVE CONTROL over the identical script, driving
// the dependency list this substrate shipped before the addressing was read live. A
// control is what makes these claims about the memo key rather than about the script:
// a publisher that never wrote anything at all would satisfy neither.

import { act, render, type RenderResult } from "@testing-library/react";
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

import {
  SUBJECT_ONE,
  SUBJECT_TWO,
  type NamedFixtureSubject,
} from "./subject-fixtures.test-support.js";
import { useSubjectScopedResource } from "./subject-scoped-resource.js";
import {
  DISCARDED_SUBJECT,
  ResourceLedger,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./subject-scoped-resource.test-support.js";
import { SubjectScopedHolder } from "./subject-scoped-holder.js";
import { useSubjectScopedState } from "./subject-scoped-state.js";

/** The key BOTH visits are addressed at, so only the addressing tells them apart. */
const DETOUR_KEY = "s1";

/** The resource a caller publishes over the one the holder seeded. */
const PUBLISHED_RESOURCE_NAME = "published";

/** How many times the A -> B -> A script addresses, and so seeds. */
const DETOUR_ADDRESSINGS = 3;

/**
 * A promise the test settles, so the suspending pass is the test's to schedule.
 *
 * The promise is made by the CALLER and handed in as a prop: React refuses to treat
 * one minted inside a render body as a suspension it can retry.
 */
class SuspensionGate {
  #open: (() => void) | undefined;
  public readonly pending: Promise<void>;

  public constructor() {
    this.pending = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  public open(): void {
    this.#open?.();
  }
}

/**
 * Drive one visit, one dropped pass at the other subject, and one visit back.
 *
 * The tree is the caller's, so the claim and its control run the identical script and
 * differ only in the dependency list their publisher was memoized on.
 */
async function driveDroppedPass<TSubject extends object>(
  treeAt: (subject: TSubject, suspendOn: Promise<void> | undefined) => ReactElement,
  visited: TSubject,
  dropped: TSubject,
): Promise<RenderResult> {
  const view = render(treeAt(visited, undefined));
  const gate = new SuspensionGate();
  await act(async () => {
    view.rerender(treeAt(dropped, gate.pending));
  });
  await act(async () => {
    gate.open();
    await gate.pending;
    view.rerender(treeAt(visited, undefined));
  });
  return view;
}

interface ValueProbeProps {
  readonly subject: object;
  /** Present on the pass React drops: the probe suspends on it. */
  readonly suspendOn: Promise<void> | undefined;
  /** Called once per addressing, which is what proves the dropped pass really ran. */
  readonly onSeed: () => void;
  readonly onReady: (publish: (next: string) => void) => void;
}

/** The value hook, driven through its own door. */
function ValueDetourProbe(props: ValueProbeProps): ReactElement {
  const { value, publish } = useSubjectScopedState<string>(props.subject, DETOUR_KEY, () => {
    props.onSeed();
    return "seed";
  });
  props.onReady(publish);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>{value}</output>;
}

/**
 * The shape this hook shipped before the addressing was read live: a PAIR-keyed memo.
 *
 * Not a stand-in for the hook — it drives the real holder through the dependency list
 * the hook used to carry, which is the one thing these cases are about.
 */
function PairKeyedValueProbe(props: ValueProbeProps): ReactElement {
  const [holder] = useState(() => new SubjectScopedHolder<string>());
  holder.address(props.subject, DETOUR_KEY, () => {
    props.onSeed();
    return "seed";
  });
  const subscribe = useCallback((onChange: () => void) => holder.subscribe(onChange), [holder]);
  const read = useCallback(() => holder.value, [holder]);
  const value = useSyncExternalStore(subscribe, read, read);
  const publish = useMemo(
    () => holder.publisherFor(props.subject, DETOUR_KEY),
    [holder, props.subject],
  );
  props.onReady(publish);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>{value}</output>;
}

interface ResourceProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly suspendOn: Promise<void> | undefined;
  readonly ledger: ResourceLedger;
  readonly onReady: (publish: (next: OpenResource) => void) => void;
}

/** The resource hook, driven through its own door. */
function ResourceDetourProbe(props: ResourceProbeProps): ReactElement {
  const { value, publish } = useSubjectScopedResource<OpenResource>(
    props.subject,
    undefined,
    () => props.ledger.open(props.subject.name),
    props.ledger.close,
  );
  props.onReady(publish);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>{value.name}</output>;
}

/**
 * The shape the two frame subsystems ran: a plain holder, a pair-keyed publisher, and
 * disposal owned by an effect.
 *
 * Its publisher names the first visit, so the resource the window opened to replace a
 * closed one is installed nowhere and closed by nothing.
 */
function PairKeyedResourceProbe(props: ResourceProbeProps): ReactElement {
  const [holder] = useState(() => new SubjectScopedHolder<OpenResource>());
  holder.address(props.subject, undefined, () => props.ledger.open(props.subject.name));
  const subscribe = useCallback((onChange: () => void) => holder.subscribe(onChange), [holder]);
  const read = useCallback(() => holder.value, [holder]);
  const value = useSyncExternalStore(subscribe, read, read);
  const publish = useMemo(
    () => holder.publisherFor(props.subject, undefined),
    [holder, props.subject],
  );
  const { ledger } = props;
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
async function driveValueDetour(
  Probe: (props: ValueProbeProps) => ReactElement,
): Promise<{ readonly view: RenderResult; readonly publish: (next: string) => void }> {
  let publishInto: (next: string) => void = () => {};
  let seedings = 0;
  const view = await driveDroppedPass<object>(
    (subject, suspendOn) => (
      <Suspense fallback={<p>waiting for the visit that was dropped</p>}>
        <Probe
          subject={subject}
          suspendOn={suspendOn}
          onSeed={() => {
            seedings += 1;
          }}
          onReady={(publish) => {
            publishInto = publish;
          }}
        />
      </Suspense>
    ),
    SUBJECT_ONE,
    SUBJECT_TWO,
  );
  // The dropped pass really ran: it addressed, and addressing is what seeds.
  expect(seedings).toBe(DETOUR_ADDRESSINGS);
  return {
    view,
    publish: (next: string): void => {
      publishInto(next);
    },
  };
}

/** What both resource cases drive, and what each is left holding. */
async function driveResourceDetour(Probe: (props: ResourceProbeProps) => ReactElement): Promise<{
  readonly view: RenderResult;
  readonly ledger: ResourceLedger;
  readonly publish: (next: OpenResource) => void;
}> {
  const ledger = new ResourceLedger();
  let publishInto: (next: OpenResource) => void = () => {};
  const view = await driveDroppedPass<NamedFixtureSubject>(
    (subject, suspendOn) => (
      <Suspense fallback={<p>waiting for the visit that was dropped</p>}>
        <Probe
          subject={subject}
          suspendOn={suspendOn}
          ledger={ledger}
          onReady={(publish) => {
            publishInto = publish;
          }}
        />
      </Suspense>
    ),
    SETTLED_SUBJECT,
    DISCARDED_SUBJECT,
  );
  // The dropped pass really ran: it opened a resource at the other subject.
  expect(ledger.opened).toContain(DISCARDED_SUBJECT.name);
  return {
    view,
    ledger,
    publish: (next: OpenResource): void => {
      publishInto(next);
    },
  };
}

describe("useSubjectScopedState — the publisher names the visit on screen", () => {
  it("publishes into the visit on screen after a dropped pass moved the addressing", async () => {
    const detour = await driveValueDetour(ValueDetourProbe);
    act(() => {
      detour.publish("the answer this visit read");
    });
    expect(detour.view.container.textContent).toBe("the answer this visit read");
  });

  it("negative control: the pair-keyed memo publishes into a visit that is over", async () => {
    // The pair is equal across the two committed visits, so the memo is not
    // recomputed and the publisher is the FIRST visit's — which the holder correctly
    // drops, leaving the surface on the seed the third visit re-addressed to.
    const detour = await driveValueDetour(PairKeyedValueProbe);
    act(() => {
      detour.publish("the answer this visit read");
    });
    expect(detour.view.container.textContent).toBe("seed");
  });
});

describe("useSubjectScopedResource — a dropped publish is an open resource nobody holds", () => {
  it("installs a published resource after a dropped pass moved the addressing", async () => {
    // The live callers' re-mint arm: a store that closed itself is replaced by
    // publishing a freshly opened one, and that publish has to land or the
    // connection it opened is held by nothing.
    const detour = await driveResourceDetour(ResourceDetourProbe);
    act(() => {
      detour.publish(detour.ledger.open(PUBLISHED_RESOURCE_NAME));
    });

    expect(detour.view.container.textContent).toBe(PUBLISHED_RESOURCE_NAME);
    detour.view.unmount();
    expect(detour.ledger.closed).toContain(PUBLISHED_RESOURCE_NAME);
  });

  it("negative control: the pair-keyed shape opens that resource and closes nothing", async () => {
    // The publish lands nowhere, so the surface goes on reading through the resource
    // it was replacing and the opened one is closed by no path at all — not on the
    // publish, not on a later render, not at unmount.
    const detour = await driveResourceDetour(PairKeyedResourceProbe);
    act(() => {
      detour.publish(detour.ledger.open(PUBLISHED_RESOURCE_NAME));
    });

    expect(detour.view.container.textContent).not.toBe(PUBLISHED_RESOURCE_NAME);
    detour.view.unmount();
    expect(detour.ledger.opened).toContain(PUBLISHED_RESOURCE_NAME);
    expect(detour.ledger.closed).not.toContain(PUBLISHED_RESOURCE_NAME);
  });
});
