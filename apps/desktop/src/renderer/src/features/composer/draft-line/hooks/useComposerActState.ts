// What the composer shows about an act while it travels, held under the address the act was
// issued at, and the writers a settlement reaches it by. Everything is held in
// `useSubjectScopedState` under `(bridge, draftKey)`, so a re-address drops it and a replaced
// bridge takes it along, rather than hiding it behind a read-time key comparison.
//
// The per-operation refusal record stays in this module; callers get the one refusal
// `renderableRefusal` yields. Both writers take the act's identity and consult the predicate
// from `useSettlementIdentities.ts`, and a settlement whose identity moved on is discarded.

import { useCallback } from "react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import type { DraftStore } from "@renderer/store/draft-store.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type SubjectScopedPublish } from "@renderer/lib/subject-scoped/subject-scoped-holder.js";
import type { SendControllerStatus } from "../send-controller-contract.js";
import {
  NO_COMPOSER_REFUSALS,
  renderableRefusal,
  withSettledRefusal,
  type ComposerRefusalsByOperation,
  type ComposerSettlementIdentity,
} from "../send-settlement.js";
import type { SettlementIdentities } from "./useSettlementIdentities.js";

/** What the composer reads about the acts at one address, and what may write it. */
export interface ComposerActState {
  /** What the bar renders while a send is traveling from THIS address. */
  readonly status: SendControllerStatus;
  /** The one refusal the bar renders, or `undefined`. */
  readonly refusal: Refusal | undefined;
  /** Publish what the send path is doing. Dropped once the address has moved. */
  readonly publishStatus: SubjectScopedPublish<SendControllerStatus>;
  /** Retire every held refusal, because the person is composing again. */
  readonly clearRefusals: () => void;
  /** Write one act's settlement, or discard it because its identity has moved on. */
  readonly settle: (
    identity: ComposerSettlementIdentity,
    settledRefusal: Refusal | undefined,
  ) => void;
  /**
   * Clear the line the act was issued on, only while that act is current. The draft store is
   * keyed by address, not visit, so an unconditional clear would erase text typed since.
   */
  readonly clearSentDraft: (identity: ComposerSettlementIdentity, sentDraftKey: string) => void;
}

/** Hold one address's act readings, and the two writers a settlement reaches them by. */
export function useComposerActState(
  bridge: PlatformBridge,
  draftKey: string,
  draftStore: DraftStore,
  isCurrent: SettlementIdentities["isCurrent"],
): ComposerActState {
  const { value: status, publish: publishStatus } = useSubjectScopedState<SendControllerStatus>(
    bridge,
    draftKey,
    () => "idle",
  );
  const { value: refusalsByOperation, publish: publishRefusalsByOperation } =
    useSubjectScopedState<ComposerRefusalsByOperation>(
      bridge,
      draftKey,
      () => NO_COMPOSER_REFUSALS,
    );

  const clearRefusals = useCallback((): void => {
    publishRefusalsByOperation(NO_COMPOSER_REFUSALS);
  }, [publishRefusalsByOperation]);

  const clearSentDraft = useCallback(
    (identity: ComposerSettlementIdentity, sentDraftKey: string): void => {
      if (isCurrent(identity)) {
        draftStore.clear(sentDraftKey);
      }
    },
    [draftStore, isCurrent],
  );

  const settle = useCallback(
    (identity: ComposerSettlementIdentity, settledRefusal: Refusal | undefined): void => {
      if (!isCurrent(identity)) {
        return;
      }
      publishRefusalsByOperation((held) => withSettledRefusal(held, identity, settledRefusal));
    },
    [isCurrent, publishRefusalsByOperation],
  );

  return {
    status,
    refusal: renderableRefusal(refusalsByOperation),
    publishStatus,
    clearRefusals,
    settle,
    clearSentDraft,
  };
}
