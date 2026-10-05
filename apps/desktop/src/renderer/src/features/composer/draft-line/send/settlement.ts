// Which act a settlement belongs to, so one target's result is never shown under another.
// A settlement carries the identity captured where the act was issued: the composer address
// (the draft key), the visit to it, the operation, and a monotonic attempt id.
//
// The visit is needed because a composer routed away and back is at the same key on two
// visits: keyed alone, a returning visit's Send would find a latch held by a call it cannot
// see, and a stale send would clear a draft typed later. A stale settlement is discarded, not
// parked, so re-addressing back never resurrects a refusal that reads as current minutes later.

import type { Refusal } from "#renderer/lib/refusal/refusal.js";

/** The acts whose settlements share the send bar's refusal; the refusal record derives from it. */
const COMPOSER_SEND_OPERATIONS = ["send"] as const;

/** One such act. */
export type ComposerSendOperation = (typeof COMPOSER_SEND_OPERATIONS)[number];

/** Which act a settlement belongs to: the address, the visit, the operation, and the attempt. */
export interface ComposerSettlementIdentity {
  /** The composer address the act was issued under: `composerDraftKey`'s value. */
  readonly draftKey: string;
  /** Which stay at the address, monotonic within one mounted composer; advanced on re-seed. */
  readonly visit: number;
  readonly operation: ComposerSendOperation;
  /** Monotonic within one mounted composer. Never reused, never compared across hooks. */
  readonly attemptId: number;
}

/** A refusal held under the identity of the act that produced it. */
export interface HeldComposerRefusal {
  readonly identity: ComposerSettlementIdentity;
  readonly refusal: Refusal;
}

/** One held refusal per operation, since readers ask what this act settled as. */
export type ComposerRefusalsByOperation = Readonly<
  Record<ComposerSendOperation, HeldComposerRefusal | undefined>
>;

/**
 * The key one act's in-flight latch is held under: the identity's axes minus the attempt.
 * The visit frees a returning visit's latch from a call still traveling for the earlier one.
 * The separator is never parsed back; keys address one window's `Map`.
 */
export function addressedOperationKey(
  draftKey: string,
  visit: number,
  operation: ComposerSendOperation,
): string {
  return `${draftKey}::${visit}::${operation}`;
}

/**
 * The attempt register narrowed to one address, dropping every retired key. Nothing else
 * removes keys, so the register would grow per dispatched act; keys of another visit or
 * target are dead once the composer re-addresses. Built by enumerating the operations
 * through `addressedOperationKey`, not by prefix or split, so it cannot disagree with it.
 * Returns a fresh record.
 */
export function attemptIdsAtAddress(
  newestAttemptIdByKey: Readonly<Record<string, number>>,
  draftKey: string,
  visit: number,
): Record<string, number> {
  const retained: Record<string, number> = {};
  for (const operation of COMPOSER_SEND_OPERATIONS) {
    const key = addressedOperationKey(draftKey, visit, operation);
    const attemptId = newestAttemptIdByKey[key];
    if (attemptId !== undefined) {
      retained[key] = attemptId;
    }
  }
  return retained;
}

/** Nothing has been refused. Frozen, so no caller writes an operation's refusal in place. */
export const NO_COMPOSER_REFUSALS: ComposerRefusalsByOperation = Object.freeze({
  send: undefined,
});

/**
 * Whether this settlement may still be written. It is stale when issued at another visit
 * (a different target, or an earlier pass at the same one) or superseded by a later attempt
 * of the same operation at this visit. The register is keyed per address, so a send at one
 * address never retires another's attempt.
 */
export function isSettlementCurrent(
  identity: ComposerSettlementIdentity,
  currentDraftKey: string,
  currentVisit: number,
  newestAttemptIdByKey: Readonly<Record<string, number>>,
): boolean {
  const key = addressedOperationKey(identity.draftKey, identity.visit, identity.operation);
  return (
    identity.draftKey === currentDraftKey &&
    identity.visit === currentVisit &&
    newestAttemptIdByKey[key] === identity.attemptId
  );
}

/** Record what one act settled as. An absent `refusal` clears only this operation's refusal. */
export function withSettledRefusal(
  refusalsByOperation: ComposerRefusalsByOperation,
  identity: ComposerSettlementIdentity,
  refusal: Refusal | undefined,
): ComposerRefusalsByOperation {
  return {
    ...refusalsByOperation,
    [identity.operation]: refusal === undefined ? undefined : { identity, refusal },
  };
}

/**
 * The refusal the bar renders, or `undefined`. There is no address guard here on purpose: the
 * refusals live in `useSubjectScopedState` under `(bridge, draftKey)`, which re-seeds on the
 * render that first sees a new subject.
 */
export function renderableRefusal(
  refusalsByOperation: ComposerRefusalsByOperation,
): Refusal | undefined {
  return refusalsByOperation.send?.refusal;
}
