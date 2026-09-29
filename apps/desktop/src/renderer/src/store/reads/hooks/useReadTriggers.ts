import type { ReadTriggerTarget } from "../read-triggers.js";
import { useSessionReadTriggers } from "./useSessionReadTriggers.js";
import { useWindowReadTriggers } from "./useWindowReadTriggers.js";
import { type SessionStore } from "../../session/session-store.js";
import type { TransportReconnectObservable } from "@renderer/lib/transport-reconnect.js";

/**
 * All of them, for a reading a session owns.
 *
 * The composition and not a further implementation: a session-scoped reading is a
 * window-scoped one that also has a session, and stating it that way is what keeps
 * the two halves from drifting into two vocabularies.
 *
 * TWO OBSERVATIONS CAN BOTH MEAN "RE-READ", AND THAT IS NOT A DUPLICATE. The window
 * half wakes when the WIRE came back; the session half wakes when this session's
 * PROJECTION became whole again after a repair read. They are different facts about
 * different things and either can happen without the other — a store repairs a
 * sequence gap on a wire that never went away, and a wire returns to a window whose
 * store was never degraded. When they do coincide, the reading's own scheduler
 * coalesces the pair into one read, which is what it is for.
 *
 * @consumedBy a session-owned reading that re-reads when the wire or the session comes back
 */
export function useReadTriggers(
  reader: ReadTriggerTarget,
  sessionStore: SessionStore,
  transportReconnect: TransportReconnectObservable,
): void {
  useWindowReadTriggers(reader, transportReconnect);
  useSessionReadTriggers(reader, sessionStore);
}
