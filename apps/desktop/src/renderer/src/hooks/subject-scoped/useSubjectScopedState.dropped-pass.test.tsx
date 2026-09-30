// A publisher outlives no visit, including one a render React dropped.
//
// Both subject hooks hand a caller a memoized `publish` captured at render. The question is
// what the memo is keyed on, and the pair alone is wrong in one direction: a view routed
// away and back is at the same pair on two visits, so a pass that re-addressed and was
// thrown away leaves the committed visit's publisher naming a visit that is over. It then
// publishes nowhere, silently, and for a resource takes whatever the caller just opened down
// with it, because the holder's discard callback runs from `address` and never from a
// publish.
//
// The driver is a pass that suspends, not the render-phase state update used in
// `useSubjectScopedResource.test.tsx`. React answers that update by re-invoking the
// component and reusing the hook cells the pass built, so a memo whose dependencies moved is
// recomputed and nothing goes stale. A suspending pass is a work-in-progress fiber React
// throws away; the next render rebuilds every hook from the last committed one, leaving a
// memo comparing this visit's dependencies against a visit two addressings ago. That is the
// concurrent discard described in `useSubjectScopedResource.ts`, driven deterministically.
//
// Both claims have a negative control over the identical script with a memo keyed on the
// pair alone, so they are about the memo key and not the script.

import { act, type RenderResult } from "@testing-library/react";
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

import { driveDroppedPass } from "./subject-scoped-hooks.test-support.js";
import {
  SUBJECT_ONE,
  SUBJECT_TWO,
  type NamedFixtureSubject,
} from "@test/helpers/subject-fixtures.js";
import { DiscardedRenderResourceProbe } from "./DiscardedRenderResourceProbe.test-support.js";
import { DiscardedRenderValueProbe } from "./DiscardedRenderValueProbe.test-support.js";
import {
  DISCARDED_RENDER_KEY,
  type ResourceProbeProps,
  type ValueProbeProps,
} from "./subject-scoped-probes.test-support.js";
import {
  DISCARDED_SUBJECT,
  ResourceOpenCloseLog,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./useSubjectScopedResource.test-support.js";
import { SubjectScopedHolder } from "@renderer/lib/subject-scoped/subject-scoped-holder.js";

/** The resource a caller publishes over the one the holder seeded. */
const PUBLISHED_RESOURCE_NAME = "published";

/**
 * Negative control: a pair-keyed memo.
 *
 * Drives the real holder through a dependency list keyed on the pair alone, the one thing
 * these cases are about.
 */
function PairKeyedValueProbe(props: ValueProbeProps): ReactElement {
  const [holder] = useState(() => new SubjectScopedHolder<string>());
  holder.address(props.subject, DISCARDED_RENDER_KEY, () => {
    props.onSeed();
    return "seed";
  });
  const subscribe = useCallback((onChange: () => void) => holder.subscribe(onChange), [holder]);
  const read = useCallback(() => holder.value, [holder]);
  const value = useSyncExternalStore(subscribe, read, read);
  const publish = useMemo(
    () => holder.publisherFor(props.subject, DISCARDED_RENDER_KEY),
    [holder, props.subject],
  );
  props.onReady(publish);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>{value}</output>;
}

/**
 * Negative control for a resource: a plain holder, a pair-keyed publisher, and disposal
 * owned by an effect.
 *
 * Its publisher names the first visit, so the resource the window opened to replace a closed
 * one is installed nowhere and closed by nothing.
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
  addressingsExpected: number,
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
  // The dropped pass really ran: it addressed, and addressing seeds. How many addressings the
  // round-trip costs is where the two arrangements part company, so each case states its own
  // count.
  expect(seedings).toBe(addressingsExpected);
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
  readonly ledger: ResourceOpenCloseLog;
  readonly publish: (next: OpenResource) => void;
}> {
  const ledger = new ResourceOpenCloseLog();
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
    // Two addressings, not three: the dropped pass proposed one and never committed it, so
    // the render back at the first subject found the committed addressing right and
    // re-seeded nothing.
    const detour = await driveValueDetour(DiscardedRenderValueProbe, 2);
    act(() => {
      detour.publish("the answer this visit read");
    });
    expect(detour.view.container.textContent).toBe("the answer this visit read");
  });

  it("negative control: the pair-keyed memo publishes into a visit that is over", async () => {
    // Three, because this holder is never told a render committed: every addressing is a
    // proposal that retires the one before it. The pair is equal across the two committed
    // visits, so the memo is not recomputed and the publisher is the first visit's, which the
    // holder correctly drops, leaving the seed the third addressing produced.
    const detour = await driveValueDetour(PairKeyedValueProbe, 3);
    act(() => {
      detour.publish("the answer this visit read");
    });
    expect(detour.view.container.textContent).toBe("seed");
  });
});

describe("useSubjectScopedResource — a dropped publish is an open resource nobody holds", () => {
  it("installs a published resource after a dropped pass moved the addressing", async () => {
    // The re-mint arm: a store that closed itself is replaced by publishing a freshly opened
    // one, and that publish has to land or the connection it opened is held by nothing.
    const detour = await driveResourceDetour(DiscardedRenderResourceProbe);
    act(() => {
      detour.publish(detour.ledger.open(PUBLISHED_RESOURCE_NAME));
    });

    expect(detour.view.container.textContent).toBe(PUBLISHED_RESOURCE_NAME);
    detour.view.unmount();
    expect(detour.ledger.closed).toContain(PUBLISHED_RESOURCE_NAME);
  });

  it("negative control: the pair-keyed shape opens that resource and closes nothing", async () => {
    // The publish lands nowhere, so the component keeps reading through the resource it was
    // replacing and the opened one is closed by no path: not on publish, a later render, or
    // unmount.
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
