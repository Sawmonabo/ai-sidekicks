// What the composer says about an act while it travels, held under the address the
// act was issued at.
//
// Four readings and two writers, and they are one module because they are one rule:
// every one of them is held in `useSubjectScopedState` under `(bridge, draftKey)`,
// which re-seeds during the render that first sees a new address. Split from
// `send-controller.ts` because that hook's job is to BUILD the acts — the router, the
// latch, the two dispatch paths, the history walk — and this one's is to say what the
// surface reads while an act is in flight and what a settlement is allowed to write.
// Neither half reads as one thing while both are one file.
//
// FOUR HOLDERS RATHER THAN ONE OBJECT. A send and a Stop can be in flight at once,
// and one publisher writing a pair would let whichever settled second overwrite what
// the other had just said. So the status, the stopping flag, the refusal slots and
// the resend offer are four holders under one key, and each act writes only its own.
//
// THE RESEND OFFER AND THE REFUSAL ARE HELD WHERE THE STATUS IS. The tripwire card
// offers the last sent body so a neutralized turn can be retried without retyping,
// and the refusal answers the act that produced it — and both used to be hook-wide
// `useState` guarded by a read-time comparison against the current draft key. A guard
// only HIDES: the row was still there, so the return trip offered one agent's words
// under another's run and rendered a refusal minutes old, and a bridge replacement —
// which retires every call made through the old transport — left both standing. Held
// under `(bridge, draftKey)` like the status, a re-address DROPS them and a replaced
// bridge takes them with it.
//
// THE SLOT RECORD NEVER LEAVES THIS MODULE. `send-settlement.ts` owns which act a
// settlement belongs to and which of two refusals the bar renders; what the composer
// is handed is the ONE refusal that rule produces. A caller holding the slots could
// read a slot the render rule would not have shown, which is a second answer to a
// question that has one — and it is the reason `renderableRefusal` is applied here
// rather than at the surface that renders its result.
//
// AND A SETTLEMENT IS ADMITTED BY ITS IDENTITY RATHER THAN BY THE KEY. Both writers
// take the act's own identity and consult the predicate `use-settlement-identities.ts`
// publishes, so "which draft does this clear" and "whose refusal may this write" are
// one question answered once. A settlement whose identity has moved on is DISCARDED
// where it lands rather than written at an address the composer has left.

import { useCallback } from "react";

import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import type { DraftStore } from "../../../console/persistence/index.js";
import { useSubjectScopedState, type SubjectScopedPublish } from "../../../console/store/index.js";
import type { SendControllerStatus } from "./send-controller-contract.js";
import {
  NO_COMPOSER_REFUSALS,
  renderableRefusal,
  withSettledRefusal,
  type ComposerRefusalSlots,
  type ComposerSettlementIdentity,
} from "./send-settlement.js";
import type { SettlementIdentities } from "./use-settlement-identities.js";

/** What the composer reads about the acts at one address, and what may write it. */
export interface ComposerActState {
  /** What the bar renders while a send is travelling from THIS address. */
  readonly status: SendControllerStatus;
  /**
   * Whether an interrupt is travelling from this address.
   *
   * Its own reading rather than a second value of {@link status}, because a send and
   * a Stop can be in flight at once and one status could not say so.
   */
  readonly isStopping: boolean;
  /** The one refusal the bar renders, newest attempt winning, or `undefined`. */
  readonly refusal: ConsoleRefusal | undefined;
  /** The most recent body sent to this address, offered back for a resend. */
  readonly resendableText: string | undefined;
  /** Publish what the send path is doing. Dropped once the address has moved. */
  readonly publishStatus: SubjectScopedPublish<SendControllerStatus>;
  /** Publish whether a Stop is in flight. Stop's own holder, and never the status. */
  readonly publishStopping: SubjectScopedPublish<boolean>;
  /** Offer one body back, or withdraw the offer. */
  readonly publishResendOffer: SubjectScopedPublish<string | undefined>;
  /**
   * Retire every slot, because the person is composing again.
   *
   * The whole record rather than the send slot alone: both acts they could have been
   * waiting on are behind them, and leaving one up would make a stale refusal read as
   * a verdict on text nobody has sent.
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
  const { value: isStopping, publish: publishStopping } = useSubjectScopedState(
    bridge,
    draftKey,
    () => false,
  );
  const { value: refusalSlots, publish: publishRefusalSlots } =
    useSubjectScopedState<ComposerRefusalSlots>(bridge, draftKey, () => NO_COMPOSER_REFUSALS);
  const { value: resendOffer, publish: publishResendOffer } = useSubjectScopedState<
    string | undefined
  >(bridge, draftKey, () => undefined);

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
    isStopping,
    refusal: renderableRefusal(refusalSlots),
    resendableText: resendOffer,
    publishStatus,
    publishStopping,
    publishResendOffer,
    clearRefusals,
    settle,
    clearSentDraft,
  };
}
