// Which act the composer is on, and whether an act that has come back is still it.
//
// Split from `send-controller.ts` because it is a different job with a different
// lifetime: nothing here reaches a wire, renders anything, or decides what a control
// says. It answers one question — is this settlement about the act on screen — and
// the controller's dispatch arms ask it three ways (may this refusal be written, may
// this draft be cleared, which attempt am I).
//
// THE VISIT IS TAKEN FROM THE HOLDER AND NOT RE-DERIVED HERE. A draft key names a
// TARGET, and a composer routed away from a target and back is at the same key on two
// different visits — the case where "same address" and "same act" come apart.
// `store/subject-scoped-state.ts` already owns exactly that distinction: its
// initializer runs on the pass that first sees a new subject, which is the definition
// of a new visit. This module started by counting its own serial off a ref, which is
// a seventh copy of the console's one addressing epoch under a seventh name; it now
// takes a serial from that holder's own re-seed instead, so there is one rule for
// when a subject becomes new and this file is not it.
//
// A pass React DISCARDS can burn a serial, and that is harmless in the one direction
// it can be wrong: an unused serial frees a latch slot that `finally` releases
// anyway, and it can never hold one a visit cannot see.
//
// THE MIRRORS ARE REFS AND NOT STATE, for the reason the single-flight latch is: both
// are written and read inside one handler's own tick, and a state read there would
// see the value from the render that produced the handler.
//
// AND THEY MOVE AT THE COMMIT, NOT DURING THE RENDER. They were assigned in the render
// body, which opted out of the very case `store/subject-scoped-holder.ts` spends its
// two-phase design on: a pass that addresses a new subject and is then THROWN AWAY.
// In that window the mirrors named a visit nothing committed, so `isCurrent` answered
// false for a settlement belonging to the visit actually on screen — its refusal
// dropped and its draft left uncleared, both silently. A layout effect is the same
// moment the holder itself confirms an addressing at, and it is the answer the render
// cannot know: a discarded pass runs no effect, so the mirrors still name the visit a
// person is looking at. Nothing in this tree discards a pass today; the first
// concurrent feature that lands is what this closes ahead of.

import { useCallback, useLayoutEffect, useRef } from "react";

import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { useSubjectScopedState } from "../../../console/store/index.js";
import {
  addressedOperationKey,
  isSettlementCurrent,
  type ComposerSendOperation,
  type ComposerSettlementIdentity,
} from "./send-settlement.js";

/** What the controller asks about the act on screen. */
export interface SettlementIdentities {
  /** Which stay at the current draft key this render is. */
  readonly visit: number;
  /** Capture the identity of one act, and make it that key's newest attempt. */
  readonly issue: (operation: ComposerSendOperation) => ComposerSettlementIdentity;
  /** Whether an act issued earlier still describes the visit on screen. */
  readonly isCurrent: (identity: ComposerSettlementIdentity) => boolean;
}

/** Mint one composer act's identity, and judge whether a settled one is still it. */
export function useSettlementIdentities(
  bridge: ConsoleBridge,
  draftKey: string,
): SettlementIdentities {
  // One serial per mount, handed out by the holder's own re-seed: the initializer
  // runs on the pass that first sees a new `(bridge, draftKey)`, so a return trip to
  // an address gets a number the earlier stay's outstanding calls cannot claim.
  const nextVisitRef = useRef(0);
  const { value: visit } = useSubjectScopedState<number>(bridge, draftKey, () => {
    nextVisitRef.current += 1;
    return nextVisitRef.current;
  });
  // The address a settlement is measured against is the composer's CURRENT one, and
  // a dispatch's own closure holds the address it was ISSUED at — so the current key
  // and visit travel through refs that every COMMITTED render refreshes, and the two
  // are compared where the call lands rather than assumed to be the same.
  const currentDraftKeyRef = useRef(draftKey);
  const currentVisitRef = useRef(visit);
  useLayoutEffect(() => {
    currentDraftKeyRef.current = draftKey;
    currentVisitRef.current = visit;
  }, [draftKey, visit]);
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
