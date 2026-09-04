// The session projection this pane reads, and the re-read a person can ask for.
//
// WHY A RE-READ EXISTS AT ALL. `peerInvocationEnabled` is a member of the session
// read, and its ABSENCE is a real state — a responder that predates it looks
// identical to one that has the grant turned off, so the control renders unknown
// and offers to ask again. That offer has to ASK. Bumping a counter and re-running
// a memo over the same synchronous store snapshot re-derives the same absence
// forever, however many times it is pressed, so the control promised a recovery it
// could not perform.
//
// WHY IT GOES THROUGH `RefreshScheduler`. `apps/desktop/AGENTS.md` puts every
// refresh through `store/scheduling.ts`, and this is a refresh: it is the same
// `sessionRead` the window's own plumbing performs, asked for again. The scheduler
// gives it the two properties a bare call would not have — a burst of presses costs
// one read, and a read requested while one is in flight becomes the NEXT read
// rather than a parallel one whose older reply could land last.
//
// WHY THE REPLY IS APPLIED THROUGH `SessionStore.initialise`. That is the store's
// own door for a read response: it rebases the sequence reconciler, drains anything
// buffered, and clears the sticky degraded flag — and it refuses a snapshot behind
// the cursor, so a re-read racing the window's own cannot undo newer events. A
// surface that held the reply itself would be a second copy of the projection, and
// the whole point of subscribing to the partition below is that there is one.
//
// The reason carried is `"subscribe"`: this read is what a surface performs when it
// needs the projection it is rendering from, which is the closest thing the closed
// `RefreshReason` vocabulary has to a person asking. It is a diagnostics label and
// changes nothing about how the read is performed — which is why it is the only
// thing here that is provisional. The vocabulary lives in `store/scheduling.ts`
// and is that family's to widen; the member this call site takes the moment a
// participant-request arm is registered there is `"participant-request"`, and the
// change is this one argument and nothing else.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import { Emitter, refuse, type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";
import {
  RefreshScheduler,
  useSessionPartition,
  type ConsoleEntity,
  type SessionStore,
} from "../../store/index.js";

/** Named in a refusal, so a failed re-read says which read failed. */
export const SESSION_PROJECTION_ORIGIN = "session-projection";

/**
 * The refusal a press gets when this mount holds no session to re-read.
 *
 * Rendered rather than swallowed: a control that does nothing at all when pressed
 * is indistinguishable from one whose read came back with the same answer, and
 * only one of those is a fact about the daemon.
 */
const NO_SESSION_TO_READ: ConsoleRefusal = refuse(
  SESSION_PROJECTION_ORIGIN,
  "no-session",
  "This console was not handed a session to read the projection from, so nothing was asked of the daemon.",
);

/**
 * Whether one session's projection reports the peer-invocation grant.
 *
 * `undefined` for BOTH an absent member and a member of the wrong type, which is
 * the honest fold: neither says the grant is off, and rendering `false` for either
 * would present an enabled session as safe.
 */
export function peerInvocationEnabledIn(
  sessionPartition: Readonly<Record<string, ConsoleEntity>>,
  sessionId: string,
): boolean | undefined {
  const projected = sessionPartition[sessionId]?.body?.["peerInvocationEnabled"];
  return typeof projected === "boolean" ? projected : undefined;
}

/**
 * One reading of the grant, and the projected row it was read from.
 *
 * The row travels beside the value because a surface holding a local settlement
 * has to know when the projection MOVED, and the value alone cannot say: a grant
 * that goes off and back on again reads identical at both ends, and a re-read that
 * answers the same way is still the daemon speaking more recently than any reply
 * this pane is remembering. The row is compared by identity and never read — the
 * store replaces it on every mutation of the session partition and on every
 * initialising read, which is exactly the set of moments that supersede a reply.
 */
export interface PeerInvocationProjection {
  readonly enabled: boolean | undefined;
  readonly source: ConsoleEntity | undefined;
}

/** What a mount with no store to subscribe to reads. Nothing was projected. */
export const NOTHING_PROJECTED: PeerInvocationProjection = {
  enabled: undefined,
  source: undefined,
};

/** One session's projected peer-invocation grant, as a subscription. */
export function usePeerInvocationProjection(sessionStore: SessionStore): PeerInvocationProjection {
  const sessionPartition = useSessionPartition(sessionStore, "session");
  const { sessionId } = sessionStore;
  return useMemo(
    () => ({
      enabled: peerInvocationEnabledIn(sessionPartition, sessionId),
      source: sessionPartition[sessionId],
    }),
    [sessionPartition, sessionId],
  );
}

/** A re-read of one session's projection, coalesced through the refresh chokepoint. */
export class SessionProjectionReRead {
  readonly #bridge: ConsoleBridge;
  readonly #sessionStore: SessionStore;
  readonly #scheduler: RefreshScheduler;
  readonly #changes = new Emitter<void>("session projection re-read");
  #refusal: ConsoleRefusal | undefined;

  public constructor(options: {
    readonly bridge: ConsoleBridge;
    readonly sessionStore: SessionStore;
  }) {
    this.#bridge = options.bridge;
    this.#sessionStore = options.sessionStore;
    this.#scheduler = new RefreshScheduler({
      clock: consoleClockFor(options.bridge),
      perform: async () => {
        await this.#read();
      },
      // The read body already turns a refused outcome into the refusal below, so
      // this arm covers a rejection from the call itself. It must exist: without
      // it the scheduler re-throws, and a re-throw inside a timer callback reaches
      // no `catch` a surface could render.
      onError: (error) => {
        this.#settle(consoleRefusalFrom(error, SESSION_PROJECTION_ORIGIN));
      },
    });
  }

  /** The last read's refusal, or `undefined` when the last read was served. */
  public get refusal(): ConsoleRefusal | undefined {
    return this.#refusal;
  }

  /** Reads actually performed. The coalescing assertion, counted rather than inferred. */
  public get readCount(): number {
    return this.#scheduler.performCount;
  }

  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Ask for a read. Repeated calls inside the coalescing window cost one read. */
  public request(): void {
    // Takes `"participant-request"` once the scheduling vocabulary registers that
    // arm; until then this is the nearest true member, never an invented one.
    this.#scheduler.request("subscribe");
  }

  /** Disarm the scheduler. Terminal, so an unmounted pane cannot hold a timer. */
  public dispose(): void {
    this.#scheduler.dispose();
  }

  async #read(): Promise<void> {
    const outcome = await this.#bridge.growth.sessionRead({
      sessionId: this.#sessionStore.sessionId,
    });
    if (outcome.status === "served") {
      this.#sessionStore.initialise(outcome.value);
      this.#settle(undefined);
      return;
    }
    // The port's own refusal, which already names the operation, the slate row and
    // the document that owes the wire. Paraphrasing it here would be the console
    // asserting a diagnosis it did not make.
    this.#settle(outcome);
  }

  #settle(refusal: ConsoleRefusal | undefined): void {
    this.#refusal = refusal;
    this.#changes.emit();
  }
}

/** What a surface drives the re-read control from. */
export interface SessionProjectionReReadBinding {
  /** Ask the daemon again. Total: a mount with no session answers with a refusal. */
  readonly requestReRead: () => void;
  readonly refusal: ConsoleRefusal | undefined;
}

/**
 * Hold one {@link SessionProjectionReRead} for as long as this mount shows one
 * session, and read its refusal.
 *
 * A hook rather than a render body, for `useAgentConsoleModels`' reason: the model
 * arms a scheduler, and a body would build a new one on every discarded pass, each
 * capable of leaving a timer behind it.
 */
export function useSessionProjectionReRead(
  bridge: ConsoleBridge | undefined,
  sessionStore: SessionStore | undefined,
): SessionProjectionReReadBinding {
  const [reRead, setReRead] = useState<SessionProjectionReRead | undefined>(undefined);
  const [unaskableRefusal, setUnaskableRefusal] = useState<ConsoleRefusal | undefined>(undefined);

  useEffect(() => {
    if (bridge === undefined || sessionStore === undefined) {
      setReRead(undefined);
      return undefined;
    }
    const built = new SessionProjectionReRead({ bridge, sessionStore });
    setReRead(built);
    return () => {
      built.dispose();
      setReRead(undefined);
    };
  }, [bridge, sessionStore]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => reRead?.onChange(onStoreChange) ?? noSubscription,
    [reRead],
  );
  const read = useCallback(() => reRead?.refusal, [reRead]);
  const readRefusal = useSyncExternalStore(subscribe, read, read);

  const requestReRead = useCallback((): void => {
    if (reRead === undefined) {
      setUnaskableRefusal(NO_SESSION_TO_READ);
      return;
    }
    setUnaskableRefusal(undefined);
    reRead.request();
  }, [reRead]);

  return { requestReRead, refusal: readRefusal ?? unaskableRefusal };
}

/** The unsubscribe a mount with no session hands `useSyncExternalStore`. */
function noSubscription(): void {
  return undefined;
}
