// This pane's rectangle, published to the host that draws its page.
//
// Split from `PreviewPaneContent.tsx`, which is the surface: this is the binding underneath
// it — one publisher, the host it writes to, and the subject both were resolved under
// — and the three rules that keep it honest across a subject swap. None of them is a
// rendering decision, and all three are the kind of thing a reader who came for the
// component's markup would skip.
//
// A BINDING OUTLIVES ITS SUBJECT. React keeps a pane instance while the window hands
// it a different bridge or the pane layout hands it a different pane, so every rule here is
// about the pass where the state still holds the PREVIOUS binding.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { PaneGeometryPublisher, type PaneGeometryOutcome } from "../geometry/geometry-publisher.js";
import type { AttachedPaneViewHost } from "../geometry/view-host.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { type AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { type Clock } from "@renderer/lib/clock.js";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { PaneSubject } from "../types.js";

/**
 * One publisher over the given host, for the pane it is for, and the subject both were
 * resolved under.
 *
 * The clock is the window's, so a frozen scenario freezes this publisher's frame with
 * every other timer in the pane. The airspace comes off the document, which an
 * overlay element and this pane share when they are in one window.
 *
 * The motion observation is the publisher's, not this function's: a self-disposal after a
 * `pane-gone` rejection ends the frame loop.
 *
 * Pure: it arms nothing at all.
 */
function createGeometryBinding(
  subject: PaneSubject,
  host: AttachedPaneViewHost,
  clock: Clock,
): BoundGeometryPublisher {
  const airspace: AirspaceRegistry = airspaceRegistryFor(document);
  return {
    ...subject,
    publisher: new PaneGeometryPublisher({ host, clock, occlusion: airspace }),
  };
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
 * How the holder ends a binding, and how it reads one that already ended.
 *
 * A terminal disposal rather than a release, because `dispose` is what the publisher
 * documents it as: the reading is what lets the holder re-mint for React's second
 * mount instead of committing the corpse the first mount's teardown left. Declared at
 * module level so both members keep one identity across every render — the hook holds
 * them on their own dependency, and a literal built in the body would move the list
 * every pass.
 */
const GEOMETRY_BINDING_DISPOSAL: SubjectScopedDisposal<BoundGeometryPublisher> = {
  dispose: closeGeometryBinding,
  isClosed: isGeometryBindingClosed,
};

/** One publisher and the subject it was resolved under. */
export interface BoundGeometryPublisher extends PaneSubject {
  readonly publisher: PaneGeometryPublisher;
}

/**
 * Publish this pane's rectangle for the life of the mount, and RENDER what the host
 * said back.
 *
 * The outcome is subscribed rather than copied. `observe` only queues the first
 * write, so a value read straight after it is `undefined` by construction — and
 * everything after it, the `pane-gone` rejection above all, would then land in the
 * publisher and reach nobody, leaving the viewport silent over a host that has said
 * this pane is destroyed. `useSyncExternalStore` rather than a
 * `useState` an effect writes into, for `LiveAnnouncerProvider`'s reason: an outcome
 * recorded between this component's render and its subscription is missed by the
 * effect shape, and a missed refusal is silent by construction.
 *
 * THE BINDING IS HELD BY THE CONSOLE'S SUBJECT-SCOPED RESOURCE HOLDER. A binding
 * outlives its subject: React keeps the instance while the window hands it a different
 * bridge or the pane layout hands it a different pane. The three arms that follow are the
 * holder's:
 *
 *   • A CHANGED SUBJECT (another bridge, pane or view host) opens its own binding
 *     DURING THE RENDER that first sees it, so there is no pass on which this hook holds
 *     the previous subject's publisher and nothing to compare on the way out.
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
  bridge: PlatformBridge,
  paneId: string,
  viewHost: AttachedPaneViewHost,
): {
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  readonly outcome: PaneGeometryOutcome | undefined;
} {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clock = useBridgeClock();
  const openBinding = useCallback(
    () => createGeometryBinding({ bridge, paneId }, viewHost, clock),
    [bridge, paneId, viewHost, clock],
  );
  // The host is part of the subject: a publisher writes to one host for life, so a
  // new host for the same pane needs a new publisher.
  const subject = useMemo(() => ({ bridge, viewHost }), [bridge, viewHost]);
  const { value: bound } = useSubjectScopedResource(
    subject,
    paneId,
    openBinding,
    GEOMETRY_BINDING_DISPOSAL,
  );
  const publisher = bound.publisher;
  const subscribe = useCallback(
    (onOutcome: () => void) => publisher.subscribeToOutcomes(onOutcome),
    [publisher],
  );
  const readOutcome = useCallback(() => publisher.lastOutcome(), [publisher]);
  const outcome = useSyncExternalStore(subscribe, readOutcome, readOutcome);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (hostElement === null) {
      return undefined;
    }
    return publisher.observe(hostElement);
  }, [publisher]);

  return { hostRef, outcome };
}
