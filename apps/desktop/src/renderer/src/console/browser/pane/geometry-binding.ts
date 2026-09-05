// This pane's rectangle, published to the host that draws its page.
//
// Split from `BrowserPane.tsx`, which is the surface: this is the binding underneath
// it — one publisher, the host it writes to, and the subject both were resolved under
// — and the three rules that keep it honest across a subject swap. None of them is a
// rendering decision, and all three are the kind of thing a reader of a 400-line
// component would skip.
//
// A BINDING OUTLIVES ITS SUBJECT. React keeps a pane instance while the window hands
// it a different bridge or the deck hands it a different pane, so every rule here is
// about the pass where the state still holds the PREVIOUS binding.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { PaneGeometryPublisher, type PaneGeometryOutcome } from "../geometry/geometry-publisher.js";
import { consoleOcclusionRegistryFor } from "../geometry/occlusion-registry.js";
import { resolvePaneViewHost, type PaneViewHost } from "../geometry/view-host.js";
import { useSubjectScopedResource } from "../../store/index.js";
import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";

/**
 * The pair a pane-scoped resource belongs to.
 *
 * Both members, because both decide where an act goes: every pane-keyed call is made
 * on ONE bridge with ONE `paneId`, so a publisher produced under either of the other
 * combinations is not a publisher for this one. It is the argument
 * {@link createGeometryBinding} takes rather than a stamp anything compares — the
 * console's subject-scoped holder addresses a resource by its subject during the
 * render that first sees a new one, so there is nothing left here to compare.
 */
export interface PaneSubject {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
}

/**
 * One publisher over the host this window actually has, for the pane it is for, and
 * the subject it was resolved under.
 *
 * The bridge and the pane id are what 12.11's wiring table selects on, and passing
 * them is the whole correction: this called the table with an empty options bag, so
 * under the fixture and the end-to-end runs it could only reach the unavailable arm
 * and every publish was suppressed — with the pane's own suites mocking the table, so
 * nothing on either side reported the gap.
 *
 * The host is kept BESIDE the publisher rather than being resolved a second time by
 * whoever needs to know what it said: one resolution per binding is what makes "this
 * pane's viewport is describing this pane's host" a fact rather than two lookups that
 * agree today.
 *
 * THE CLOCK AND THE OVERLAY REGISTRY BOTH COME OFF THE BRIDGE, which is the same rule
 * twice. `Spec-023 §Console Design (Meridian)` §The fixture bridge: "the fixture clock
 * is the only clock the renderer reads in fixture mode", and the console has one answer
 * to which clock a window reads. A privately minted `RealClock` here was invisible to
 * `ManualClock` — the instrument the budgets are counted with — so under a frozen
 * scenario this publisher's frame and its `sampledAtMs` ran on wall time while every
 * other timer in the same pane was stopped, and whether a screenshot caught the first
 * publish was decided by how fast the runner was.
 *
 * Pure: it arms nothing.
 */
export function createGeometryBinding(subject: PaneSubject): BoundGeometryPublisher {
  const host = resolvePaneViewHost(subject);
  return {
    ...subject,
    host,
    publisher: new PaneGeometryPublisher({
      host,
      clock: consoleClockFor(subject.bridge),
      occlusion: consoleOcclusionRegistryFor(subject.bridge),
    }),
  };
}

/**
 * What a binding says before its first publish — the host's own refusal where the
 * wiring table has none, and nothing where it has one.
 *
 * The resting value exists because a binding is minted in a render and armed in an
 * effect, so there is always one committed pass with no recorded outcome. On an
 * unavailable host that pass has a fact to report and reporting nothing would make it
 * indistinguishable from a pane nobody has told anything yet, which is rule 8's
 * collapse. On an attached host it genuinely has none: the first sample has not been
 * taken. `observe` records the same suppression a frame later, so this is the same
 * sentence early rather than a second author of it.
 */
function restingGeometryOutcome(host: PaneViewHost): PaneGeometryOutcome | undefined {
  return host.state === "unavailable" ? { status: "suppressed", refusal: host.refusal } : undefined;
}

/** Ends a binding. Terminal: `dispose` is what the publisher documents it as. */
function closeGeometryBinding(bound: BoundGeometryPublisher): void {
  bound.publisher.dispose();
}

/** Whether a binding's own disposal has already run, however it was reached. */
function isGeometryBindingClosed(bound: BoundGeometryPublisher): boolean {
  return bound.publisher.isDisposed;
}

/**
 * Publish this pane's rectangle for the life of the mount, and RENDER what the host
 * said back.
 *
 * The outcome is subscribed rather than copied. `observe` only queues the first
 * write, so a value read straight after it is `undefined` by construction — and
 * everything after it, the `pane-gone` rejection above all, would then land in the
 * publisher and reach nobody, leaving the viewport saying "no page yet" over a host
 * that has said this pane is destroyed. `useSyncExternalStore` rather than a
 * `useState` an effect writes into, for `LiveAnnouncerProvider`'s reason: an outcome
 * recorded between this component's render and its subscription is missed by the
 * effect shape, and a missed refusal is silent by construction.
 *
 * THE BINDING IS HELD BY THE CONSOLE'S SUBJECT-SCOPED RESOURCE HOLDER, which is what
 * this hook used to hand-roll. A binding outlives its subject — React keeps the
 * instance while the window hands it a different bridge or the deck hands it a
 * different pane — and the three arms that follow from it are all the holder's:
 *
 *   • A CHANGED SUBJECT opens its own binding DURING THE RENDER that first sees it, so
 *     there is no pass on which this hook holds the previous window's publisher and
 *     nothing to compare on the way out. The stamp-and-suppress this replaced was
 *     correct and one concept wider than it had to be.
 *   • A DOUBLE MOUNT is answered by `isGeometryBindingClosed`. React runs the cleanup
 *     and mounts the same instance again, so the second mount would otherwise be
 *     handed the corpse the first one's teardown just disposed; the holder re-mints
 *     rather than committing a resource that will never work again.
 *   • A SELF-DISPOSAL after a `pane-gone` rejection STAYS DISPOSED, because the holder
 *     reads that reading only where its lifetime effect runs. That arm is terminal on
 *     purpose: the host has said this pane is gone, and re-minting would ask it again
 *     every frame.
 *
 * The attachment below is the one thing the holder does not own, because it is about
 * an ELEMENT rather than a subject: the publisher's own detacher is its disposal, so
 * the effect returns it directly and the holder's `close` is the same act reached the
 * other way — both idempotent, and both terminal by the publisher's own contract.
 */
export function useGeometryPublisher(
  bridge: ConsoleBridge,
  paneId: string,
): {
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  readonly outcome: PaneGeometryOutcome | undefined;
} {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const openBinding = useCallback(
    () => createGeometryBinding({ bridge, paneId }),
    [bridge, paneId],
  );
  const { value: bound } = useSubjectScopedResource(
    bridge,
    paneId,
    openBinding,
    closeGeometryBinding,
    isGeometryBindingClosed,
  );
  const publisher = bound.publisher;
  const subscribe = useCallback(
    (onOutcome: () => void) => publisher.subscribeToOutcomes(onOutcome),
    [publisher],
  );
  const readOutcome = useCallback(() => publisher.lastOutcome(), [publisher]);
  const publishedOutcome = useSyncExternalStore(subscribe, readOutcome, readOutcome);
  const outcome = publishedOutcome ?? restingGeometryOutcome(bound.host);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (hostElement === null) {
      return undefined;
    }
    return publisher.observe(hostElement);
  }, [publisher]);

  return { hostRef, outcome };
}

/** One publisher, the host it writes to, and the subject both were resolved under. */
export interface BoundGeometryPublisher extends PaneSubject {
  readonly host: PaneViewHost;
  readonly publisher: PaneGeometryPublisher;
}
