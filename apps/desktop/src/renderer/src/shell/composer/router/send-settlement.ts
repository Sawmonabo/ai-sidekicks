// Which act a settlement belongs to, so one target's result is never presented
// under another.
//
// A settlement carries its own identity, captured where the act was issued: the
// composer ADDRESS (the draft key), the VISIT to that address, the OPERATION, and a
// monotonic ATTEMPT id. None is redundant. The address is what a refusal is about, so
// a send to Ada that the daemon refuses after the person re-addressed the composer to
// Priya is never rendered under Priya. The attempt id separates one act from the next
// act of the same operation at the same address.
//
// THE ADDRESS IS THE DRAFT KEY AND NOT A SECOND NOTION OF "SAME TARGET". The draft
// store already keys this composer's text by address, so a settlement takes the same
// key rather than a parallel identity that could answer differently.
//
// THE ADDRESS IS A VISIT AND NOT ONLY A KEY. A composer routed away from a target and
// back is at the same key on two different visits, which is exactly where "same
// address" and "same act" come apart. Held on the key alone, the single-flight latch
// still held a slot for a call the returning visit could not see (Send did nothing), a
// settlement cleared a draft typed on the second visit because the first visit's send
// had cleared the first visit's text, and a refusal written on the first visit read as
// current again. The visit is the composer's mirror of the holder's own addressing
// epoch (`store/subject-scoped/subject-scoped-state.ts` states the same fact for the
// value it holds), so the latch key, the attempt register, and the settlement identity
// all carry it.
//
// A STALE SETTLEMENT IS DISCARDED RATHER THAN PARKED. A completion whose address is no
// longer the composer's, or whose attempt has been superseded, is dropped where it
// lands and never written, so re-addressing back to the target it was issued for does
// not resurrect it. A refusal that reappears minutes later, attached to nothing the
// person just did, is a worse answer than no refusal at all.

import type { ConsoleRefusal } from "../../../console/core/index.js";

/**
 * The acts whose settlements share the send bar's refusal surface.
 *
 * Closed and declared once, with the slot record derived from it, so a second act
 * cannot be given a settlement path while the slot record still holds one.
 */
const COMPOSER_SEND_OPERATIONS = ["send"] as const;

/** One such act. Derived from the enumeration above. */
export type ComposerSendOperation = (typeof COMPOSER_SEND_OPERATIONS)[number];

/** Which act a settlement belongs to: the visit, the operation, and the attempt. */
export interface ComposerSettlementIdentity {
  /** The composer address the act was issued under — `composerDraftKey`'s value. */
  readonly draftKey: string;
  /**
   * Which VISIT to that address, monotonic within one mounted composer.
   *
   * The key says which target; this says which stay at it. Two visits to one target
   * are two addresses as far as every act is concerned, and the composer advances
   * this on the same render the holder re-seeds on.
   */
  readonly visit: number;
  readonly operation: ComposerSendOperation;
  /** Monotonic within one mounted composer. Never reused, never compared across hooks. */
  readonly attemptId: number;
}

/**
 * The key one act's in-flight slot is held under, while it is still travelling.
 *
 * The same three axes the identity carries, minus the attempt: the latch answers
 * whether THIS VISIT to this address already has a send going, and the attempt id is
 * what separates one such act from the next, which is a question about settlements
 * rather than about admission. Composed here rather than inside the hook
 * so that what the latch calls "the same act at the same address" and what a
 * settlement calls it cannot drift apart.
 *
 * The visit is what frees a returning visit's slot. Without it a call still
 * travelling for the first stay at a target held the key the second stay computes,
 * so the second stay's Send found the slot taken by a call it could not see, and the
 * press did nothing at all — the one outcome a control may not have.
 *
 * The segments are joined by a separator that appears in none of them, and no reader
 * splits one back: keys address entries in one window's `Map` and are never parsed.
 */
export function addressedOperationKey(
  draftKey: string,
  visit: number,
  operation: ComposerSendOperation,
): string {
  return `${draftKey}::${visit}::${operation}`;
}

/**
 * The attempt register narrowed to one address, dropping every key it retired.
 *
 * WHY THE REGISTER NEEDS NARROWING AT ALL. Nothing ever removed a key, so it grew one
 * entry per dispatched act for the life of the mounted composer — an unbounded
 * register in a family that bounds every wire-controlled list it renders. The entries
 * were not merely surplus: {@link isSettlementCurrent} reads a key only when the
 * identity's own `draftKey` and `visit` are the composer's current pair, so every key
 * from a retired visit or another target is dead the instant the composer
 * re-addresses, and no later act can ever read one again.
 *
 * BUILT BY ENUMERATION AND NOT BY FILTERING, which is what makes it exact. The
 * retained set is one key per operation in a closed vocabulary, composed
 * through the same function that wrote them, so this cannot disagree with
 * `addressedOperationKey` about what a key looks like. A prefix or `split` test would
 * have to reason about a separator inside a caller-supplied `draftKey` — which the key
 * function itself deliberately never does — and would be a second, weaker statement of
 * a shape stated once next door.
 *
 * The result is a fresh record rather than a mutation, so a caller holding the old one
 * across the swap reads a consistent register either way.
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

/** A refusal held under the identity of the act that produced it. */
export interface HeldComposerRefusal {
  readonly identity: ComposerSettlementIdentity;
  readonly refusal: ConsoleRefusal;
}

/**
 * One slot per operation, rather than one slot for the bar.
 *
 * A record keyed by the operation and not a list, because the question every reader
 * asks is "what did THIS act settle as".
 */
export type ComposerRefusalSlots = Readonly<
  Record<ComposerSendOperation, HeldComposerRefusal | undefined>
>;

/** Nothing has been refused. Frozen, so no caller writes a slot in place. */
export const NO_COMPOSER_REFUSALS: ComposerRefusalSlots = Object.freeze({
  send: undefined,
});

/**
 * Whether this settlement may still be written.
 *
 * Both halves, because they fail in different ways. An act issued at another VISIT
 * has a result about a stay the composer has left — a different target, or the same
 * target on an earlier pass, which is the case a key-only comparison called current
 * and then cleared a draft typed after it. An act superseded by a later attempt of
 * the same operation AT THE SAME VISIT has a result the person has already moved
 * past. Either one makes the settlement stale, and a stale settlement is discarded.
 *
 * The register is keyed by `addressedOperationKey` and not by operation alone: two
 * slots for the whole window let a send at one address retire an attempt at another,
 * so a refusal the person was looking at was dropped because an unrelated address
 * had dispatched since.
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

/**
 * Record what one act settled as, leaving every other operation's slot untouched.
 *
 * `refusal` absent is the settlement that SUCCEEDED, and it clears this operation's
 * own slot and nothing else.
 */
export function withSettledRefusal(
  slots: ComposerRefusalSlots,
  identity: ComposerSettlementIdentity,
  refusal: ConsoleRefusal | undefined,
): ComposerRefusalSlots {
  return {
    ...slots,
    [identity.operation]: refusal === undefined ? undefined : { identity, refusal },
  };
}

/**
 * The refusal the bar renders, or `undefined`.
 *
 * THERE IS NO ADDRESS GUARD HERE, and that is the design rather than an omission. The
 * slots are held in `useSubjectScopedState` under the same `(bridge, draftKey)` the
 * status is, which re-seeds on the render that first sees a new subject: the holder is
 * the guard, and a guard beside it would be a second answer to the same question.
 */
export function renderableRefusal(slots: ComposerRefusalSlots): ConsoleRefusal | undefined {
  return slots.send?.refusal;
}
