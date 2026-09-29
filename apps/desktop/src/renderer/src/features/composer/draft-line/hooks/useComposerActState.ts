// What the composer says about an act while it travels, held under the address the
// act was issued at.
//
// Two readings and the writers a settlement reaches them by. Every reading is held in
// `useSubjectScopedState` under `(bridge, draftKey)`, which re-seeds during the render
// that first sees a new address. Split from `send-controller.ts` because that hook's
// job is to BUILD the acts — the router, the latch, the dispatch path, the history
// walk — and this one's is to say what the surface reads while an act is in flight and
// what a settlement is allowed to write.
//
// THE REFUSAL IS HELD WHERE THE STATUS IS. The refusal answers the act that produced
// it, and a hook-wide `useState` guarded by a read-time comparison against the current
// draft key would only HIDE it: the row would still be there, so the return trip would
// render a refusal minutes old, and a bridge replacement — which retires every call
// made through the old transport — would leave it standing. Held under `(bridge,
// draftKey)` like the status, a re-address DROPS it and a replaced bridge takes it
// with it.
//
// THE SLOT RECORD NEVER LEAVES THIS MODULE. `send-settlement.ts` owns which act a
// settlement belongs to and which refusal the bar renders; what the composer is handed
// is the ONE refusal that rule produces. A caller holding the slots could read a slot
// the render rule would not have shown, which is a second answer to a question that
// has one — and it is the reason `renderableRefusal` is applied here rather than at
// the surface that renders its result.
//
// AND A SETTLEMENT IS ADMITTED BY ITS IDENTITY RATHER THAN BY THE KEY. Both writers
// take the act's own identity and consult the predicate `use-settlement-identities.ts`
// publishes, so "which draft does this clear" and "whose refusal may this write" are
// one question answered once. A settlement whose identity has moved on is DISCARDED
// where it lands rather than written at an address the composer has left.

import { useCallback } from "react";

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import type { ConsoleRefusal } from "@renderer/lib/refusal.js";
import type { DraftStore } from "@renderer/store/draft-store.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type SubjectScopedPublish } from "@renderer/lib/subject-scoped/subject-scoped-holder.js";
import type { SendControllerStatus } from "../send-controller-contract.js";
import {
  NO_COMPOSER_REFUSALS,
  renderableRefusal,
  withSettledRefusal,
  type ComposerRefusalSlots,
  type ComposerSettlementIdentity,
} from "../send-settlement.js";
import type { SettlementIdentities } from "./useSettlementIdentities.js";

/** What the composer reads about the acts at one address, and what may write it. */
export interface ComposerActState {
  /** What the bar renders while a send is travelling from THIS address. */
  readonly status: SendControllerStatus;
  /** The one refusal the bar renders, or `undefined`. */
  readonly refusal: ConsoleRefusal | undefined;
  /** Publish what the send path is doing. Dropped once the address has moved. */
  readonly publishStatus: SubjectScopedPublish<SendControllerStatus>;
  /**
   * Retire every slot, because the person is composing again.
   *
   * Leaving one up would make a stale refusal read as a verdict on text nobody has
   * sent.
   */
  readonly clearRefusals: () => void;
  /** Write one act's settlement, or discard it because its identity has moved on. */
  readonly settle: (
    identity: ComposerSettlementIdentity,
    settledRefusal: ConsoleRefusal | undefined,
  ) => void;
  /**
   * Clear the line the act was issued on, but only while that act is still current.
   *
   * The draft store is keyed by ADDRESS and not by visit, so on a return trip the
   * captured key names a different draft with the same name: an unconditional clear
   * erased text the person typed on the second visit to answer a send made on the
   * first.
   */
  readonly clearSentDraft: (identity: ComposerSettlementIdentity, sentDraftKey: string) => void;
}

/** Hold one address's act readings, and the two writers a settlement reaches them by. */
export function useComposerActState(
  bridge: ConsoleBridge,
  draftKey: string,
  draftStore: DraftStore,
  isCurrent: SettlementIdentities["isCurrent"],
): ComposerActState {
  const { value: status, publish: publishStatus } = useSubjectScopedState<SendControllerStatus>(
    bridge,
    draftKey,
    () => "idle",
  );
  const { value: refusalSlots, publish: publishRefusalSlots } =
    useSubjectScopedState<ComposerRefusalSlots>(bridge, draftKey, () => NO_COMPOSER_REFUSALS);

  const clearRefusals = useCallback((): void => {
    publishRefusalSlots(NO_COMPOSER_REFUSALS);
  }, [publishRefusalSlots]);

  const clearSentDraft = useCallback(
    (identity: ComposerSettlementIdentity, sentDraftKey: string): void => {
      if (isCurrent(identity)) {
        draftStore.clear(sentDraftKey);
      }
    },
    [draftStore, isCurrent],
  );

  const settle = useCallback(
    (identity: ComposerSettlementIdentity, settledRefusal: ConsoleRefusal | undefined): void => {
      if (!isCurrent(identity)) {
        return;
      }
      publishRefusalSlots((slots) => withSettledRefusal(slots, identity, settledRefusal));
    },
    [isCurrent, publishRefusalSlots],
  );

  return {
    status,
    refusal: renderableRefusal(refusalSlots),
    publishStatus,
    clearRefusals,
    settle,
    clearSentDraft,
  };
}
