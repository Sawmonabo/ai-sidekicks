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

/** Which act a settlement belongs to: the address, the operation, and the attempt. */
export interface ComposerSettlementIdentity {
  /** The composer address the act was issued under — `composerDraftKey`'s value. */
  readonly draftKey: string;
  readonly operation: ComposerSendOperation;
  /** Monotonic within one mounted composer. Never reused, never compared across hooks. */
  readonly attemptId: number;
}

/**
 * The key one act's in-flight slot is held under, while it is still travelling.
 *
 * The same two axes the identity carries, minus the attempt: the latch answers
 * whether THIS address already has a send — or a Stop — going, and the attempt id is
 * what separates one such act from the next, which is a question about settlements
 * rather than about admission. Composed here rather than inside the hook so that
 * what the latch calls "the same act at the same address" and what a settlement
 * calls it cannot drift apart.
 *
 * The two segments are joined by a separator that appears in neither, and no reader
 * splits one back: keys address entries in one window's `Map` and are never parsed.
 */
export function addressedOperationKey(draftKey: string, operation: ComposerSendOperation): string {
  return `${draftKey}::${operation}`;
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
 * Both halves, because they fail in different ways. An act issued at another address
 * has a result about a target the composer is no longer pointed at; an act superseded
 * by a later attempt of the same operation has a result the person has already moved
 * past. Either one makes the settlement stale, and a stale settlement is discarded.
 */
export function isSettlementCurrent(
  identity: ComposerSettlementIdentity,
  currentDraftKey: string,
  newestAttemptIdByOperation: Readonly<Record<ComposerSendOperation, number>>,
): boolean {
  return (
    identity.draftKey === currentDraftKey &&
    newestAttemptIdByOperation[identity.operation] === identity.attemptId
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
 * The refusal the bar renders at this address, or `undefined`.
 *
 * Newest attempt wins where both operations have refused at this address: the bar
 * shows one refusal and the later act is the one the person is waiting on an answer
 * to. A slot held under another address renders nothing — the second guard, standing
 * after the write, so a re-address stops rendering a refusal that was current when
 * it landed.
 */
export function renderableRefusal(
  slots: ComposerRefusalSlots,
  currentDraftKey: string,
): ConsoleRefusal | undefined {
  let newest: HeldComposerRefusal | undefined;
  for (const operation of COMPOSER_SEND_OPERATIONS) {
    const held = slots[operation];
    if (held === undefined || held.identity.draftKey !== currentDraftKey) {
      continue;
    }
    if (newest === undefined || held.identity.attemptId > newest.identity.attemptId) {
      newest = held;
    }
  }
  return newest?.refusal;
}
