// Which act the composer is on, and whether an act that has come back is still it. It
// answers one question for the controller: is this settlement about the act on screen.
//
// The visit comes from `useSubjectScopedState`'s re-seed, not a counter of its own: a draft key
// names a target, and a composer routed away and back is at the same key on two visits. A
// discarded React pass can burn a serial, which is harmless since an unused serial only frees a
// latch claim that `finally` releases anyway.
//
// The mirrors are refs, read inside one handler's tick where state would be stale. They move
// in a layout effect, not the render body, so a pass that addresses a new subject and is then
// discarded never leaves them naming a visit nothing committed.

import { useCallback, useLayoutEffect, useRef } from "react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import {
  addressedOperationKey,
  attemptIdsAtAddress,
  isSettlementCurrent,
  type ComposerSendOperation,
  type ComposerSettlementIdentity,
} from "../send-settlement.js";

/** What the controller asks about the act on screen. */
export interface SettlementIdentities {
  /** Which stay at the current draft key this render is. */
  readonly visit: number;
  readonly issue: (operation: ComposerSendOperation) => ComposerSettlementIdentity;
  readonly isCurrent: (identity: ComposerSettlementIdentity) => boolean;
}

/** Mint one composer act's identity, and judge whether a settled one is still it. */
export function useSettlementIdentities(
  bridge: PlatformBridge,
  draftKey: string,
): SettlementIdentities {
  // One serial per mount, handed out by the holder's re-seed, so a return to an address gets a
  // number the earlier stay's outstanding calls cannot claim.
  const nextVisitRef = useRef(0);
  const { value: visit } = useSubjectScopedState<number>(bridge, draftKey, () => {
    nextVisitRef.current += 1;
    return nextVisitRef.current;
  });
  // Settlements are measured against the composer's current address, while a dispatch closure
  // holds the one it was issued at, so both travel through refs that each commit refreshes.
  const currentDraftKeyRef = useRef(draftKey);
  const currentVisitRef = useRef(visit);
  useLayoutEffect(() => {
    currentDraftKeyRef.current = draftKey;
    currentVisitRef.current = visit;
    // Narrowed in the same commit that retires other addresses' keys, so there is one rule
    // for which keys are live.
    newestAttemptIdRef.current = attemptIdsAtAddress(newestAttemptIdRef.current, draftKey, visit);
  }, [draftKey, visit]);
  const nextAttemptIdRef = useRef(0);
  // Keyed by `addressedOperationKey`, not by operation alone, so a send from one address
  // cannot retire an attempt made at another. Narrowed above to the address on screen, so it
  // holds at most one entry per operation.
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
