// Binds this pane's rectangle publisher to the page host that draws its page. A binding outlives
// its subject: React keeps the pane instance across a new bridge, pane or page host, so the
// hook must never hold the previous subject's publisher.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { PaneGeometryPublisher, type PaneGeometryOutcome } from "../geometry/geometry-publisher.js";
import type { PageHost } from "../geometry/page-host.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { useOwnerWindow } from "@renderer/hooks/owner-window/useOwnerWindow.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { type AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { type Clock } from "@renderer/lib/clock.js";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { PaneSubject } from "../types.js";

/**
 * One publisher over the given page host, for the pane it is for. The clock is the window's, so the
 * scenario at a fixed frame holds the publisher's frame; the airspace comes off the document, which
 * an overlay and this pane share within one window. Arms nothing.
 */
function createGeometryBinding(
  subject: PaneSubject,
  pageHost: PageHost,
  clock: Clock,
  ownerDocument: Document,
): BoundGeometryPublisher {
  const airspace: AirspaceRegistry = airspaceRegistryFor(ownerDocument);
  return {
    ...subject,
    publisher: new PaneGeometryPublisher({ pageHost, clock, occlusion: airspace }),
  };
}

/** Ends a binding; `dispose` is terminal. */
function closeGeometryBinding(bound: BoundGeometryPublisher): void {
  bound.publisher.dispose();
}

/** Whether a binding's disposal has already run, however it was reached. */
function isGeometryBindingClosed(bound: BoundGeometryPublisher): boolean {
  return bound.publisher.isDisposed;
}

/**
 * How the holder ends a binding and recognizes one that already ended. Module-level so both
 * members keep one identity across renders and do not move the hook's dependency list.
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
 * Publish this pane's rectangle for the life of the mount, and return what the page host said
 * back.
 *
 * The outcome is subscribed, not copied: `observe` only queues the first write, so a value read
 * straight after it is `undefined`, and a later `pane-gone` rejection would reach nobody.
 * `useSyncExternalStore` rather than an effect writing state, which misses an outcome recorded
 * between render and subscription.
 *
 * The subject-scoped holder keeps the binding:
 *   - A changed subject (bridge, pane or page host) opens its binding during the render that
 *     first sees it, so no pass holds the previous publisher.
 *   - A double mount finds the binding disposed and gets a fresh one.
 *   - A self-disposal after a `pane-gone` rejection stays disposed on purpose: re-minting would
 *     ask a page host that said the pane is gone again on every frame.
 *
 * The element attachment stays here: the publisher's detacher is its disposal, so the effect
 * returns it directly.
 */
export function useGeometryPublisher(
  bridge: PlatformBridge,
  paneId: string,
  pageHost: PageHost,
): {
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  readonly outcome: PaneGeometryOutcome | undefined;
} {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clock = useBridgeClock();
  const ownerDocument = useOwnerWindow().document;
  const openBinding = useCallback(
    () => createGeometryBinding({ bridge, paneId }, pageHost, clock, ownerDocument),
    [bridge, paneId, pageHost, clock, ownerDocument],
  );
  // A publisher writes to one page host for life, so a new page host needs a new publisher.
  const subject = useMemo(() => ({ bridge, pageHost }), [bridge, pageHost]);
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
