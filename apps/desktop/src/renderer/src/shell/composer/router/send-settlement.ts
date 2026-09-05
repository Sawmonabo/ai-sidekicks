// Which act a settlement belongs to, so one target's result is never presented
// under another.
//
// THE DEFECT THIS MODULE EXISTS TO END. The send bar held ONE refusal slot for the
// whole hook. A send to Ada that the daemon refused while the person re-addressed
// the composer to Priya wrote Ada's refusal into the slot the bar was by then
// rendering for Priya — a verdict on a message Priya never received, attached to a
// target it was never about. The same slot let a concurrent success or a Stop erase
// the other operation's refusal, so a refusal a person had not read could vanish
// because an unrelated act happened to settle.
//
// SO A SETTLEMENT CARRIES ITS OWN IDENTITY, CAPTURED WHERE THE ACT WAS ISSUED. The
// identity is the composer ADDRESS the act was issued under, the OPERATION it was,
// and a monotonic ATTEMPT id. All three are needed and none is redundant: the
// address is what a refusal is about, the operation is what makes Stop's settlement
// Stop's own rather than the send path's, and the attempt id is what separates one
// act from the next act of the same operation at the same address.
//
// THE ADDRESS IS THE DRAFT KEY AND NOT A SECOND NOTION OF "SAME TARGET". The draft
// store already keys this composer's text by address, and `send-controller.ts` holds
// the resend offer under that same key for the same reason — a body written for one
// target is not an offer to send it to another. A settlement is the same kind of
// fact, so it takes the same key rather than a parallel identity that could answer
// differently.
//
// AND A STALE SETTLEMENT IS DISCARDED RATHER THAN PARKED. A completion whose address
// is no longer the composer's, or whose attempt has been superseded, is dropped
// where it lands: it is never written, so re-addressing back to the target it was
// issued for does not resurrect it. A refusal that reappears minutes later, attached
// to nothing the person just did, is a worse answer than no refusal at all.
//
// SO THE ADDRESS IS A VISIT AND NOT ONLY A KEY. A draft key names a TARGET, and a
// composer routed away from a target and back is at the same key on two different
// visits — which is exactly the case where "same address" and "same act" come apart.
// Held on the key alone, three things went wrong at once on the return trip: the
// single-flight latch still held a slot for a call the returning visit could not
// see, so Send was enabled and silently did nothing; a settlement measured only
// against the key cleared a draft typed on the SECOND visit because the first
// visit's send had cleared the first visit's text; and a refusal written on the
// first visit read as current again. The visit is the composer's mirror of the
// holder's own addressing epoch — `store/subject-scoped-state.ts` states the same
// fact for the value it holds, "a surface routed away and back is at the same pair
// on two different visits, and only the addressing tells them apart" — so the latch
// key, the attempt register, and the settlement identity all carry it and all three
// agree about what "the act on screen" means.

import type { ConsoleRefusal } from "../../../console/core/index.js";

/**
 * The acts whose settlements share the send bar's refusal surface.
 *
 * Closed and declared once, with the slot record derived from it, so a third act
 * cannot be given a settlement path while the slot record still holds two.
 */
const COMPOSER_SEND_OPERATIONS = ["send", "stop"] as const;

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
 * whether THIS VISIT to this address already has a send — or a Stop — going, and the
 * attempt id is what separates one such act from the next, which is a question about
 * settlements rather than about admission. Composed here rather than inside the hook
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

/** A refusal held under the identity of the act that produced it. */
export interface HeldComposerRefusal {
  readonly identity: ComposerSettlementIdentity;
  readonly refusal: ConsoleRefusal;
}

/**
 * One slot per operation, rather than one slot for the bar.
 *
 * A record keyed by the operation and not a list, because the question every reader
 * asks is "what did THIS act settle as" — and a list would make answering it a
 * search whose result depends on insertion order.
 */
export type ComposerRefusalSlots = Readonly<
  Record<ComposerSendOperation, HeldComposerRefusal | undefined>
>;

/** Nothing has been refused. Frozen, so no caller writes a slot in place. */
export const NO_COMPOSER_REFUSALS: ComposerRefusalSlots = Object.freeze({
  send: undefined,
  stop: undefined,
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
 * own slot and nothing else — which is the half of the defect that let a successful
 * send erase a Stop's refusal, and a Stop erase a send's.
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
 * Newest attempt wins where both operations have refused: the bar shows one refusal
 * and the later act is the one the person is waiting on an answer to.
 *
 * THERE IS NO ADDRESS GUARD HERE, and that is the fix rather than an omission. The
 * slots used to be a hook-wide `useState` that a read-time comparison merely HID on
 * another address — so the row was still there and the return trip rendered it
 * again, minutes later, attached to nothing the person had just done. The slots are
 * now held in `useSubjectScopedState` under the same `(bridge, draftKey)` the status
 * is, which re-seeds on the render that first sees a new subject: the holder is the
 * guard, and a guard beside it would be a second answer to the same question.
 */
export function renderableRefusal(slots: ComposerRefusalSlots): ConsoleRefusal | undefined {
  let newest: HeldComposerRefusal | undefined;
  for (const operation of COMPOSER_SEND_OPERATIONS) {
    const held = slots[operation];
    if (held === undefined) {
      continue;
    }
    if (newest === undefined || held.identity.attemptId > newest.identity.attemptId) {
      newest = held;
    }
  }
  return newest?.refusal;
}
