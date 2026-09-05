// Which act the composer is on, and whether an act that has come back is still it.
//
// Split from `send-controller.ts` because it is a different job with a different
// lifetime: nothing here reaches a wire, renders anything, or decides what a control
// says. It answers one question — is this settlement about the act on screen — and
// the controller's dispatch arms ask it three ways (may this refusal be written, may
// this draft be cleared, which attempt am I).
//
// THE VISIT IS THE COMPOSER'S MIRROR OF THE HOLDER'S ADDRESSING EPOCH. A draft key
// names a TARGET, and a composer routed away from a target and back is at the same
// key on two different visits — the case where "same address" and "same act" come
// apart. `store/subject-scoped-state.ts` states the same fact for the value it
// holds: "a surface routed away and back is at the same pair on two different
// visits, and only the addressing tells them apart". So the serial advances during
// the render that first sees a new key, which is the render the holders re-seed on,
// and every keyed thing in this family carries it.
//
// A pass React DISCARDS can advance it, and that is harmless in the one direction it
// can be wrong: an unused serial frees a latch slot that `finally` releases anyway,
// and it can never hold one a visit cannot see.
//
// THE REGISTERS ARE REFS AND NOT STATE, for the reason the single-flight latch is:
// both are written and read inside one handler's own tick, and a state read there
// would see the value from the render that produced the handler.

import { useCallback, useRef } from "react";

import {
  addressedOperationKey,
  isSettlementCurrent,
  type ComposerSendOperation,
  type ComposerSettlementIdentity,
} from "./send-settlement.js";

/** What the controller asks about the act on screen. */
export interface SettlementRegister {
  /** Which stay at the current draft key this render is. */
  readonly visit: number;
  /** Capture the identity of one act, and make it that key's newest attempt. */
  readonly issue: (operation: ComposerSendOperation) => ComposerSettlementIdentity;
  /** Whether an act issued earlier still describes the visit on screen. */
  readonly isCurrent: (identity: ComposerSettlementIdentity) => boolean;
}

/** Track the composer's visit to one address, and the newest attempt of each act. */
export function useSettlementRegister(draftKey: string): SettlementRegister {
  const visitRef = useRef({ draftKey, serial: 0 });
  if (visitRef.current.draftKey !== draftKey) {
    visitRef.current = { draftKey, serial: visitRef.current.serial + 1 };
  }
  const visit = visitRef.current.serial;
  // The address a settlement is measured against is the composer's CURRENT one, and
  // a dispatch's own closure holds the address it was ISSUED at — so the current key
  // and visit travel through refs that every render refreshes, and the two are
  // compared where the call lands rather than assumed to be the same.
  const currentDraftKeyRef = useRef(draftKey);
  currentDraftKeyRef.current = draftKey;
  const currentVisitRef = useRef(visit);
  currentVisitRef.current = visit;
  const nextAttemptIdRef = useRef(0);
  // Keyed by `addressedOperationKey` and not by operation: two slots for the whole
  // window let a send from one address retire an attempt made at another, so a
  // refusal the person was looking at was discarded because an unrelated address had
  // dispatched since — the one path where the address check passes and the guard
  // still fires.
  const newestAttemptIdRef = useRef<Record<string, number>>({});

  const issue = useCallback((operation: ComposerSendOperation): ComposerSettlementIdentity => {
    nextAttemptIdRef.current += 1;
    const identity: ComposerSettlementIdentity = {
      draftKey: currentDraftKeyRef.current,
      visit: currentVisitRef.current,
      operation,
      attemptId: nextAttemptIdRef.current,
    };
    newestAttemptIdRef.current[
      addressedOperationKey(identity.draftKey, identity.visit, identity.operation)
    ] = identity.attemptId;
    return identity;
  }, []);

  const isCurrent = useCallback(
    (identity: ComposerSettlementIdentity): boolean =>
      isSettlementCurrent(
        identity,
        currentDraftKeyRef.current,
        currentVisitRef.current,
        newestAttemptIdRef.current,
      ),
    [],
  );

  return { visit, issue, isCurrent };
}
