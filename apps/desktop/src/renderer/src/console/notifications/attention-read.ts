// When the attention projection is read, and what makes it be read again.
//
// `attention-plane.ts` owns the vocabulary, the boundary narrowing, and the fold.
// This module owns the one thing those cannot: a lifetime. It performs the read,
// holds its result, and re-reads it when the session projections underneath it move
// — which is what makes the notification center and the all-sessions list report
// what needs a person NOW rather than what needed them when the destination was
// first opened.
//
// THE SIGNAL IS THE SESSION PROJECTION, NOT A TIMER. `Spec-023 §Console Design
// (Meridian)` §The eight rules forbids interval polling outright, and there is no
// `attention.subscribe` to open — the corpus registers a projection READ and no
// stream. What the console already holds is the session stores themselves: an
// attention item is derived from canonical session state, so a session store whose
// state moved is the honest signal that the projection may have moved with it. The
// registry's own open/close emitter carries the other half, because a session that
// has just been opened may already carry attention nobody has read yet.
//
// AND EVERY RE-READ GOES THROUGH THE CHOKEPOINT. `PushDrivenRead` is the console's
// one push-driven read discipline — subscribe first, treat the push as opaque,
// coalesce through `store/scheduling.ts`'s `RefreshScheduler`, serialize so no stale
// reply wins, and never return a loaded surface to its loading shape. A second read
// engine written here would be a second answer to all five of those questions; a
// stream of settling events therefore costs one read rather than one read per event.
//
// THE FOUR PHASES ARE THE READ'S OWN, MAPPED ONCE. `PushDrivenRead` reports
// `not-loaded | loaded | failed`, and the projection's "nothing was read" lives
// inside the loaded arm as an absent value — because the reader answers `undefined`
// for a question it could not put. That mapping is written here, in one function, so
// no surface narrows on both vocabularies at once.

import { useEffect, useMemo } from "react";

import type { Unsubscribe } from "@ai-sidekicks/contracts";

import { consoleClockFor, type ConsoleBridge } from "../bridge/index.js";
import {
  PushDrivenRead,
  usePushDrivenRead,
  type PushDrivenReadState,
} from "../collaboration/push-driven-read.js";
import type { SessionStoreRegistry } from "../store/index.js";
import {
  AttentionPlane,
  narrowAttentionProjection,
  type AttentionProjectionReader,
  type AttentionReading,
} from "./attention-plane.js";

/** The subsystem name a failed attention read names itself with. */
const ATTENTION_READ_ORIGIN = "attention-plane";

/**
 * Every session projection this window holds, as one opaque change signal.
 *
 * A class rather than a closure over a `Map`, because it owns two kinds of
 * subscription with a rebinding rule between them: the registry's own open/close
 * emitter, and one subscription per open session store. A session opened after this
 * signal started has to be bound, and a session closed has to be released — a signal
 * that bound once would go quiet for exactly the sessions a person just opened.
 */
class SessionProjectionSignal {
  readonly #registry: SessionStoreRegistry;
  readonly #onSessionChange: () => void;
  readonly #storeReleasesBySessionId = new Map<string, Unsubscribe>();
  #registryRelease: Unsubscribe | undefined;

  public constructor(registry: SessionStoreRegistry, onSessionChange: () => void) {
    this.#registry = registry;
    this.#onSessionChange = onSessionChange;
  }

  /** Bind the registry and every store it already holds, in that order. */
  public start(): void {
    this.#registryRelease = this.#registry.subscribe(() => {
      this.#bindOpenSessions();
      this.#onSessionChange();
    });
    this.#bindOpenSessions();
  }

  /** Release every subscription this signal opened. Terminal. */
  public dispose(): void {
    this.#registryRelease?.();
    this.#registryRelease = undefined;
    for (const release of this.#storeReleasesBySessionId.values()) {
      release();
    }
    this.#storeReleasesBySessionId.clear();
  }

  #bindOpenSessions(): void {
    const openSessionIds = new Set(this.#registry.openSessionIds);
    for (const [sessionId, release] of [...this.#storeReleasesBySessionId]) {
      if (!openSessionIds.has(sessionId)) {
        release();
        this.#storeReleasesBySessionId.delete(sessionId);
      }
    }
    for (const sessionId of openSessionIds) {
      if (this.#storeReleasesBySessionId.has(sessionId)) {
        continue;
      }
      const store = this.#registry.peek(sessionId);
      if (store === undefined) {
        continue;
      }
      this.#storeReleasesBySessionId.set(
        sessionId,
        store.readable.subscribe(() => {
          this.#onSessionChange();
        }),
      );
    }
  }
}

/**
 * Read every session projection this window holds as one change signal.
 *
 * The shape `PushDrivenRead` takes for a subscription: opened once, answered with a
 * fresh read, released by the handle it returns.
 */
function subscribeToSessionProjections(
  registry: SessionStoreRegistry,
  onSessionChange: () => void,
): Unsubscribe {
  const signal = new SessionProjectionSignal(registry, onSessionChange);
  signal.start();
  return () => {
    signal.dispose();
  };
}

/** The read's three states as the plane's four phases. Written once, here. */
function attentionReadingFrom(
  state: PushDrivenReadState<readonly unknown[] | undefined>,
): AttentionReading {
  if (state.kind === "not-loaded") {
    return { phase: "reading" };
  }
  if (state.kind === "failed") {
    return { phase: "refused", refusal: state.refusal };
  }
  if (state.value === undefined) {
    return { phase: "not-asked" };
  }
  const narrowed = narrowAttentionProjection(state.value);
  return {
    phase: "read",
    plane: new AttentionPlane(narrowed.items),
    droppedCount: narrowed.droppedCount,
  };
}

/**
 * Perform the projection read and keep it current.
 *
 * ONE read for the whole destination. The notification center renders it and the
 * all-sessions list takes each row's severity off the same plane, so the two cannot
 * disagree about what needs a person — which two reads, however carefully written,
 * eventually would.
 *
 * The read is CONSTRUCTED in the render body and STARTED in an effect, which is the
 * split `settings/pages/WorkspaceMountsPage.tsx` already makes: constructing one
 * opens nothing and arms nothing, so a render React discards leaves no subscription
 * behind, and the subscribe-and-read that must not happen during render rides the
 * effect.
 */
export function useAttentionProjection(
  read: AttentionProjectionReader,
  bridge: ConsoleBridge,
  sessionStoreRegistry: SessionStoreRegistry,
): AttentionReading {
  const projectionRead = useMemo(
    () =>
      new PushDrivenRead<readonly unknown[] | undefined>({
        // The scenario's frozen clock under the fixture and the real one otherwise,
        // resolved inside the construction the bridge already keys — the shape
        // `settings/pages/WorkspaceMountsPage.tsx` takes for the same reason: this
        // read's coalescing window has to advance when a story advances everything
        // else's.
        clock: consoleClockFor(bridge),
        origin: ATTENTION_READ_ORIGIN,
        read,
        subscribe: (onChangeSignal) =>
          subscribeToSessionProjections(sessionStoreRegistry, onChangeSignal),
      }),
    [bridge, read, sessionStoreRegistry],
  );
  useEffect(() => {
    projectionRead.start();
    return () => {
      projectionRead.dispose();
    };
  }, [projectionRead]);

  const state = usePushDrivenRead(projectionRead);
  return useMemo(() => attentionReadingFrom(state), [state]);
}
