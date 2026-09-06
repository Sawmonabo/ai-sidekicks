// The roster's read seam and the view state it settles into.
//
// `NodeRoster.tsx` beside this file RENDERS a roster. This module is where the
// roster is READ: the seam a host hands in, the three-state union the read settles
// into, and the hook that holds one under the subject it was read for. The split is
// the component's own seam — a reader chasing "why did the rows not change" reads
// this file, and a reader chasing "why does the row not say that" reads the other.
//
// THE SEAM IS REQUIRED, AND THAT IS THE POINT. This view used to default to
// `window.sidekicks.controlPlane.call(…)` and `window.sidekicks.daemon.subscribe(…)`
// with the two wire strings written out here, which made this the SECOND production
// home for both — the first is `console/bridge/runtime-node-roster.ts`, which is
// where the registered procedure name and the presence event set are declared once
// and where the all-or-nothing subscription policy is argued. The two homes had
// already diverged: the bridge module subscribes to all five registered
// state-transition names and refuses partially, and the default arm here subscribed
// to `runtime_node.online` alone — one of five, which is the configuration the
// sibling module argues is the worst available, because a roster that updates
// sometimes is the hardest kind of staleness to notice. So the default arm is gone
// rather than repaired: every mount supplies the seam, `console/seats/absorbed-surfaces.ts`
// composes it from the console's own bridge, and this view names no wire at all.
//
// WHY IT IS A SEAM RATHER THAN A DIRECT BRIDGE CALL. A host that resolves its own
// bridge holds a different object from the installed one and cannot otherwise stand
// in for it — which is what made this view unreadable in a fixture build. Taking the
// pair as a prop is also what keeps the console's "no `window.sidekicks` outside the
// bridge" rule a matter of STRUCTURE rather than of a guard that renders an absence.

import { useCallback, useEffect } from "react";

import type {
  RuntimeNodeRosterEntry,
  RuntimeNodeRosterRequest,
  RuntimeNodeRosterResponse,
  SessionId,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

// The wire-rejection normalizer is shared across every renderer surface and both
// Electron processes, so it lives in `src/shared/` rather than being written a fourth
// time here (Plan-023 Phase 1B). It renders ANY code+message envelope with the wire
// `code` as `Error.name`, which is what this view's below-floor labeling needed: a
// `version.floor_exceeded` read refusal surfaces as `version.floor_exceeded: <server
// message>` rather than collapsing to `[object Object]`. The compile-time binding to
// the contracts literal survives in the one view that BRANCHES on the code
// (`MixedVersionStatus.tsx#VERSION_FLOOR_EXCEEDED_WIRE_CODE`).
import { wireRejectionToError } from "../../../shared/wire-errors.js";

// The held-answer stamp, taken from the console's ONE implementation of the rule
// rather than written a second time here. A settled roster belongs to the session AND
// the transport it was read through, and comparing only one of those during render is
// what left a retired transport's rows on screen.
//
// Through the store family's DOOR rather than by a deep specifier: a deep import from
// outside the console reaches around a boundary no layering rule can see, since every
// rule in `.dependency-cruiser.mjs` is scoped to a `from` inside `console/`. The door
// is where the console publishes what a consumer outside it may hold.
import { useSubjectScopedState } from "../console/store/index.js";

/**
 * The two reads this view performs, as one substitutable seam.
 *
 * REQUIRED, and narrower than the bridge surfaces a host composes it from.
 * `readRoster` takes the registered REQUEST and no procedure name, and
 * `subscribePresence` takes the session and no event name, because which procedure
 * answers a roster read and which registered `runtime_node.*` names a presence
 * subscription carries are facts about the wire rather than choices a host makes — a
 * seam that took them as arguments would invite a second, quieter answer to both,
 * which is exactly the divergence the retired default arm had already produced.
 *
 * A HOST HOLDS ONE PAIR PER TRANSPORT. The effect below depends on this object's
 * identity, because a replaced transport is the one change a session-keyed dependency
 * cannot see, so a pair composed fresh on every render resubscribes on every render.
 * That is a host's own doing rather than a hazard hidden here: the console's mount
 * caches one seam per bridge.
 */
export interface NodeRosterReads {
  /** One session's roster snapshot, as the registered read answers it. */
  readRoster: (request: RuntimeNodeRosterRequest) => Promise<RuntimeNodeRosterResponse>;
  /**
   * Node presence transitions for one session, as an opaque change signal.
   *
   * The handler takes NO payload: a push says WHEN to re-read and the snapshot read
   * stays the source of the rendered set, so this view holds no second copy of the
   * roster and cannot drift from it.
   */
  subscribePresence: (sessionId: SessionId, onPresenceChange: () => void) => Unsubscribe;
}

/**
 * What the roster read has settled into, as a discriminated union.
 *
 * Mount-triggered, so it STARTS in `loading` — the read fires on mount and there is
 * no button. Each variant maps 1:1 to a rendered branch, so the render is a total
 * function over the union. The `loaded` variant carries the verbatim
 * `RuntimeNodeRosterEntry[]` from the read — the shipped wire DTO, not a local
 * view-model — so the render binds to the real contract axes by construction.
 *
 * No-flicker contract: `loading` is what the view shows whenever nothing has been
 * read FOR THE CURRENT SUBJECT, and the subject is the (session, transport) pair the
 * effect reads through. It is NOT re-entered on a same-subject re-read, so a
 * live-health re-read updates the node set IN PLACE.
 */
export type RosterViewState =
  | { kind: "loading" }
  | { kind: "loaded"; nodes: RuntimeNodeRosterEntry[] }
  | { kind: "error"; error: Error };

/**
 * The "nothing has been read for this subject yet" answer, as one frozen value.
 *
 * A module constant rather than a fresh literal, so the identity of the absence does
 * not change between the passes that produce it — the same reasoning `store/hooks.ts`
 * gives for freezing its own not-loaded arm.
 */
const ROSTER_NOT_READ: RosterViewState = { kind: "loading" };

/**
 * What this view holds, and the one act it offers over it.
 *
 * A pair rather than the bare state, because the STREAM-OPEN failure has no path
 * back on its own. A failed READ recovers by itself — the subscription that survived
 * pushes again and the next refresh publishes `loaded` — but a `subscribePresence`
 * that threw leaves no subscription to push, and the effect re-runs only when the
 * session or the transport moves. Neither moves when a concurrency cap clears thirty
 * seconds later, so without a caller-reachable re-open the column stood on one line
 * of error text for the life of that pair, with a transient refusal and a permanent
 * one indistinguishable.
 */
export interface NodeRosterReading {
  readonly viewState: RosterViewState;
  /**
   * Tear the current attempt down and open another.
   *
   * Meaningful from every arm and offered only from the failed one: a re-open costs
   * a subscribe and a read, which a column that is already listening does not need.
   * It re-runs the effect by moving one of its dependencies, so the teardown that
   * releases the old subscription is the effect's own cleanup rather than a second
   * release path this hook would have to keep in step with it.
   */
  readonly retry: () => void;
}

/**
 * Read one session's roster through one transport, and keep it stamped with both.
 *
 * The held roster is STAMPED with the subject it was read for, rather than kept beside
 * a comparison of one prop. A session change and a transport change are the same
 * failure — rows answering a question that has been replaced — and the second one is
 * the invisible half: the session id does not move when the console's bridge provider
 * swaps its resolution, and a refresh deliberately never re-enters `loading`, so the
 * retired bridge's roster would stand until the replacement read settled, which is
 * unbounded. Stamping substitutes the not-read answer in the render that first sees
 * the new address, BEFORE commit, so no pass paints the old transport's rows under the
 * new one. It also drops a reply published for a subject this view has left, which is
 * the belt to the effect's own `cancelled` braces.
 *
 * The transport is the SUBJECT and the session id is the KEY — the pair this view is
 * addressed by, written in the holder's own terms.
 */
export function useNodeRosterRead(sessionId: SessionId, reads: NodeRosterReads): NodeRosterReading {
  const { value: rosterViewState, publish: publishRosterViewState } =
    useSubjectScopedState<RosterViewState>(reads, sessionId, () => ROSTER_NOT_READ);
  // The attempts made for THIS address, held by the same holder the roster is, so a
  // session or transport change starts a fresh count rather than carrying a number
  // that describes an address this view has left. Its only job is to be a dependency
  // the effect can be moved by; nothing renders it.
  const { value: attemptOrdinal, publish: publishAttemptOrdinal } = useSubjectScopedState<number>(
    reads,
    sessionId,
    () => 0,
  );
  const retry = useCallback(() => {
    publishAttemptOrdinal((held) => held + 1);
  }, [publishAttemptOrdinal]);

  useEffect(() => {
    // Strict-mode-safe mount. The closure-scoped `let cancelled`, flipped in cleanup,
    // makes any in-flight read resolution a no-op after this effect run is torn down,
    // so nothing publishes on an unmounted (or about-to-be-remounted) tree under
    // StrictMode's double-invoke. The `let` RESETS per effect run, which is what
    // neutralizes the double-invoke; a persisting `useRef` would not.
    let cancelled = false;

    // Effect-scoped monotonic read sequence — the out-of-order guard. Multiple
    // refreshes can be IN FLIGHT at once (rapid presence pushes each kick off a read)
    // and the seam gives no resolution-ordering guarantee; without this counter an
    // OLDER read resolving AFTER a NEWER one would overwrite fresh rows with stale.
    let latestRequestSequence = 0;

    // Held so cleanup can release the subscription. `undefined` until the synchronous
    // `subscribePresence(...)` below succeeds — a host with no live channel throws
    // there, so `unsubscribe?.()` in cleanup is a safe no-op.
    let unsubscribe: Unsubscribe | undefined;

    const { readRoster, subscribePresence } = reads;

    // Shared snapshot read, used for BOTH the initial read and every push-triggered
    // refresh. The async-IIFE shape funnels a SYNCHRONOUS throw from the seam and a
    // rejection into the same `catch`: a bare `readRoster(...).then(...).catch(...)`
    // evaluates the call first, and a sync throw would escape before `.then` is
    // reached and crash the effect callback, which React does not catch. This function
    // NEVER publishes `{ kind: "loading" }` — only `loaded` / `error` — so a refresh
    // never flashes back to the loading branch.
    const refreshSnapshot = (): void => {
      const requestSequence = ++latestRequestSequence;
      void (async () => {
        try {
          const rosterResponse = await readRoster({ sessionId });
          if (cancelled || requestSequence !== latestRequestSequence) return;
          // The full node set is rendered (admit-not-eject, I-003-1): no `.filter(...)`
          // drops a node by `state`, `healthState`, or `readOnly`.
          publishRosterViewState({ kind: "loaded", nodes: rosterResponse.nodes });
        } catch (bridgeError: unknown) {
          if (cancelled || requestSequence !== latestRequestSequence) return;
          // A TYPED refusal keeps its wire code as the rendered `Error.name` —
          // including the below-floor `version.floor_exceeded` verdict, which is the
          // read reflection of AC2's at-floor vs below-floor distinguishability. A
          // re-read failure flips the whole roster to `error`, matching the
          // initial-read failure; a resilient "keep the last snapshot" is a Tier-8
          // polish rather than a Tier-3 requirement.
          publishRosterViewState({ kind: "error", error: wireRejectionToError(bridgeError) });
        }
      })();
    };

    try {
      // Subscribe FIRST, before the initial read: a transition landing after the
      // snapshot but before the subscription installs would otherwise be lost. The
      // synchronous call gets its own `try` because a host with no live channel throws
      // here, and an uncaught throw would crash the effect callback and strand the
      // view. The handler re-invokes `refreshSnapshot`, which closes over `cancelled`
      // and the sequence guard; the push payload is never decoded.
      unsubscribe = subscribePresence(sessionId, () => {
        refreshSnapshot();
      });

      // INSIDE the same `try`, AFTER the subscribe assignment, so a subscribe throw
      // skips the read rather than clobbering the error with a snapshot that has no
      // live channel behind it. A READ failure is still owned by the IIFE's `catch`.
      refreshSnapshot();
    } catch (subscribeError: unknown) {
      if (!cancelled) {
        publishRosterViewState({ kind: "error", error: wireRejectionToError(subscribeError) });
      }
    }

    return () => {
      cancelled = true;
      // Idempotent per the `Unsubscribe` contract; `?.()` no-ops when the subscribe
      // threw before assigning.
      unsubscribe?.();
    };
    // `[sessionId, reads, publishRosterViewState]`: the effect reads and subscribes
    // through a specific transport for a specific session, so a change to EITHER must
    // tear the old subscription down and re-run. `reads` is a dependency because "same
    // session, different transport" is a state a host genuinely reaches — the console's
    // bridge provider REPLACES its resolution without remounting its children — and
    // left out, this effect would stay subscribed to the superseded bridge and keep
    // reading a disposed engine with nothing on screen saying so. The publisher's
    // identity moves exactly when the ADDRESSING does, which is these same two inputs,
    // so listing it adds no re-run and states what the effect closed over.
    //
    // `attemptOrdinal` is the re-open. It moves only when the failed arm's control is
    // pressed, and moving it tears this run down — releasing the subscription, if one
    // opened — and runs the whole body again from the subscribe.
  }, [sessionId, reads, publishRosterViewState, attemptOrdinal]);

  return { viewState: rosterViewState, retry };
}
