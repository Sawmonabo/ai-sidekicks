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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  PaneGeometryPublisher,
  type PaneGeometryOutcome,
} from "../../browser/geometry-publisher.js";
import { consoleOcclusionRegistryFor } from "../../browser/occlusion-registry.js";
import { isCurrentPaneSubject, type PaneSubject } from "../../browser/pane-subject.js";
import { resolvePaneViewHost, type PaneViewHost } from "../../browser/view-host.js";
import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";

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
 * The publisher is minted in a `useState` initializer and RE-MINTED when the state
 * holds a disposed one, which is `frame/ui-state-lifecycle.ts`'s shape for the same
 * hazard: React's double-mount runs the cleanup and then mounts the same component
 * instance again, so the second mount would otherwise be handed the corpse the first
 * one's teardown just disposed. Asking the publisher rather than remembering is what
 * makes that arm correct without a second flag beside it — and the effect's only
 * dependency is the publisher, so a self-disposal after a rejection does NOT re-mint:
 * that arm is terminal on purpose.
 */
export function useGeometryPublisher(
  bridge: ConsoleBridge,
  paneId: string,
): {
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  readonly outcome: PaneGeometryOutcome | undefined;
} {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const subject: PaneSubject = { bridge, paneId };
  const [bound, setBound] = useState<BoundGeometryPublisher>(() => createGeometryBinding(subject));
  const publisher = bound.publisher;
  const subscribe = useCallback(
    (onOutcome: () => void) => publisher.subscribeToOutcomes(onOutcome),
    [publisher],
  );
  const readOutcome = useCallback(() => publisher.lastOutcome(), [publisher]);
  const publishedOutcome = useSyncExternalStore(subscribe, readOutcome, readOutcome);
  // THE COMPARISON, DURING RENDER, and it is the whole of this correction. A binding
  // outlives its subject: React keeps this instance while the window hands it a
  // different bridge or the deck hands it a different pane, and until the passive
  // effect below has run the state still holds the PREVIOUS binding. Reading its
  // outcome on that pass put the retired host's published view under the new
  // subject's viewport — a rectangle a different window accepted, presented as this
  // one's. Suppressed here rather than cleared in an effect, because an effect runs
  // one pass after the pass a person reads.
  const isCurrentBinding = isCurrentPaneSubject(bound, subject);
  const outcome = isCurrentBinding
    ? (publishedOutcome ?? restingGeometryOutcome(bound.host))
    : restingGeometryOutcome(resolvePaneViewHost(subject));

  useEffect(() => {
    // The subject a publisher was minted FOR is carried beside it, because the host
    // is addressed per bridge and per pane: a deck that swaps either would otherwise
    // leave the publisher writing this element's rectangle to the previous window's
    // host under the previous pane's address. The re-mint is here and not in the
    // render body because it is paired with the disposal below — React may throw a
    // render away, and a publisher disposed on a pass that never committed is a
    // pane with no publisher at all.
    if (publisher.isDisposed || !isCurrentPaneSubject(bound, { bridge, paneId })) {
      setBound(createGeometryBinding({ bridge, paneId }));
      return undefined;
    }
    const hostElement = hostRef.current;
    if (hostElement === null) {
      return undefined;
    }
    const detach = publisher.observe(hostElement);
    return () => {
      detach();
      publisher.dispose();
    };
  }, [bound, bridge, paneId, publisher]);

  return { hostRef, outcome };
}

/** One publisher, the host it writes to, and the subject both were resolved under. */
export interface BoundGeometryPublisher extends PaneSubject {
  readonly host: PaneViewHost;
  readonly publisher: PaneGeometryPublisher;
}
