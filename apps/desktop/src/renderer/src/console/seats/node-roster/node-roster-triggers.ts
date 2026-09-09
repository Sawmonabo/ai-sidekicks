// The moments the absorbed roster is asked to read again that its own channel is not.
//
// SPLIT OUT OF `node-roster-seam.ts`, WHICH OWNS WHAT THE READ ANSWERED, and a sibling
// of `node-roster-refresh.ts`, which owns what a burst of reasons COSTS. Three subjects
// on one seam, and one file was carrying all three: the record, the schedule, and the
// mount-side wiring that decides which signals reach the schedule at all.
//
// IT SITS ABOVE THE SEAM AND THE SEAM DOES NOT KNOW IT EXISTS. This module reaches the
// seam through `requestNodeRosterRefresh` and the seam imports nothing from here, so the
// edge runs one way — `triggers → seam → refresh` — and the family carries no cycle.
// Writing the hook beside the seam registry would have closed one the moment either
// module grew a second reader.

import { useEffect, useMemo } from "react";

import type { SessionEventType, SessionId } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  subscribeToSessionEventKinds,
  useWindowReadTriggers,
  type ReadTriggerTarget,
  type SessionStore,
} from "../../store/index.js";
import { requestNodeRosterRefresh } from "./node-roster-seam.js";

/**
 * The registered session-event kinds whose arrival owes this roster a fresh read.
 *
 * `pty.control_changed` and nothing else. `controlHolder` rides the roster RESPONSE —
 * one write lease exists per session, so it is not a column on the node table — and the
 * settings page renders it beside the rows out of this same recorded read. It is the
 * one member of that reply nothing on the presence channel announces: the
 * `runtime_node.*` names move a node's state and its declared capabilities, and the
 * lease moves under none of them. Without this the terminal-control line stood on
 * whatever the last node transition happened to have read.
 *
 * Typed as registered `SessionEventType` members, so a kind the wire never emits is a
 * compile error rather than a trigger that silently never fires.
 */
const ROSTER_REREAD_EVENT_KINDS: readonly SessionEventType[] = ["pty.control_changed"];

/**
 * The same declaration in the shape a {@link ReadTriggerTarget} publishes it.
 *
 * DERIVED, never listed twice. Which events change an answer is a property of the
 * QUESTION, and the two consumers of that property — the window trigger set, which
 * publishes it, and the session-store signal, which compares against it — must not be
 * able to disagree about it.
 */
const ROSTER_REREAD_EVENT_KIND_SET: ReadonlySet<string> = Object.freeze(
  new Set<string>(ROSTER_REREAD_EVENT_KINDS),
);

/**
 * The four moments the absorbed roster re-reads that its own presence channel is not.
 *
 * THE MOUNT ARM IS THE ONE THAT IS DROPPED. `useWindowReadTriggers` fires on mount,
 * on focus, and on the transport coming back; the mount arm is the absorbed view's own
 * initial read, so forwarding it would put a second `runtimenode.roster` on the wire
 * for one mount, which is the duplication this whole seam exists to avoid. The other
 * two are re-reads of a roster this window already holds and are both forwarded — a
 * reconnect is exactly the edge after which the held roster is most likely stale.
 *
 * THE FOURTH IS THE SESSION'S OWN LEASE FRAME, and it is why this hook takes a store.
 * `ROSTER_REREAD_EVENT_KINDS` states which kinds; the store's own transition signal is
 * how they are noticed, through the console's one implementation of that fold rather
 * than a second cursor walk written here. `undefined` is a real answer and not a defect
 * — settings opens with no session — and it costs this reading its lease signal and
 * nothing else, which is why the effect is written to be total over it rather than the
 * hook being split in two.
 *
 * Every reason reaches the same `RefreshScheduler`, so a focus, a reconnect and a lease
 * frame arriving together cost one read of the roster rather than three.
 */
export function useNodeRosterReReadTriggers(
  bridge: ConsoleBridge,
  sessionId: SessionId | string | undefined,
  sessionStore: SessionStore | undefined,
): void {
  const target = useMemo<ReadTriggerTarget>(
    () => ({
      triggeringEventKinds: ROSTER_REREAD_EVENT_KIND_SET,
      requestRead: (reason) => {
        if (reason === "subscribe" || sessionId === undefined) {
          return;
        }
        requestNodeRosterRefresh(bridge, sessionId, reason);
      },
    }),
    [bridge, sessionId],
  );
  useWindowReadTriggers(target, bridge.transportReconnect);

  useEffect(() => {
    if (sessionStore === undefined || sessionId === undefined) {
      return;
    }
    return subscribeToSessionEventKinds(sessionStore, ROSTER_REREAD_EVENT_KINDS, () => {
      requestNodeRosterRefresh(bridge, sessionId, "terminal-event");
    });
  }, [bridge, sessionId, sessionStore]);
}
