// Where a read STOPS, and the only place in the console that can stop one.
//
// A READ HAS AN OWNER, AND THE OWNER CAN LEAVE BEFORE THE ANSWER ARRIVES. Three
// sessions open, a four-thousand-line diff on the wire, and the person flips to
// another pane before it lands. Nothing anywhere stopped that read: the promise went
// on resolving, the reply went on being parsed against its registered schema, the
// projection went on being built, and the frame that painted it was thrown away —
// all of it on the same thread the streaming ledger paints on. The answer was
// correct and nobody was waiting for it. What this module removes is that
// competition.
//
// A SCOPE, A ROUND, AND WHY THEY ARE TWO THINGS. A scope is a read LINE — one
// surface's reads of one subject — and it lives exactly as long as that pairing
// does. A round is one read on that line. The two endings are different facts and a
// caller has to be able to tell them apart: a round ends because a NEWER read
// superseded it and the line goes on, and a scope ends because the surface that
// owned it is gone and nothing on that line will be read again. Collapsing them
// would make a re-read look like a teardown, which is how a live surface comes to
// hold a signal that is already aborted.
//
// THE ROUND IS THE LATCH CLAIM PLUS THE SIGNAL, AND THAT IS THE WHOLE OF THE
// PAIRING. `generation-latch.ts` already answers "may this settlement install"; this
// answers "is anybody still waiting". They were two conventions a caller could
// observe one of, and the shape here is what makes that impossible: there is no way
// to obtain a signal without also obtaining the claim it belongs with, because they
// are one value. A scheduler that mints rounds therefore cannot schedule a read that
// nothing can supersede — not because a reviewer checked, but because the round is
// the only thing it has to hand its performer.
//
// FIRE AND FORGET, IN BOTH DIRECTIONS. Nothing awaits an abort and nothing is queued
// behind one: aborting is a synchronous flag flip and a listener call, and the read
// it ends was already unowned. A surface that comes back issues a fresh read
// immediately — the scope it returns to is a NEW scope, because the subject pairing
// that addresses it was re-addressed. So there is no state to unwind and no window in
// which a returning surface is waiting for a cancellation to complete.
//
// WHAT IS DELIBERATELY NOT CANCELLABLE, AND WHY THE LIST IS SHORT AND HARD. Reads,
// and reads only. A mutation is never handed a signal — a durable act that has
// reached the daemon has HAPPENED, and abandoning the console's half of it would
// leave a person looking at a surface that says an act did not occur while the record
// says it did. A run control (pause, interrupt, cancel, stop) is a mutation by that
// same reading. A store-owned subscription is not a read at all: it belongs to the
// session's store rather than to any pane, it outlives every pane that reads through
// it, and a pane unmounting must not take it down. And the session store's own base
// snapshot read is the store's, for the same reason. None of those four ever receives
// a signal, which is a property of their call sites rather than a mode here.
//
// NO DAEMON-SIDE PER-REQUEST CANCEL IS ADDED, AND NONE IS PROPOSED. What is
// cancellable here is the console's own interest in an answer: the pending promise is
// dropped, the reply is never parsed, and no projection is built from it. The daemon
// goes on doing whatever it had already started, because there is no registered wire
// on which to tell it otherwise — the one cancellation the protocol has is
// `$/subscription/cancel`, which ends a STREAM and says nothing about a one-shot
// call. Registering a per-request cancel would be a wire addition, which is a
// contract question and not this seam's.
//
// WHAT THIS IS NOT. It is not a scheduler — when a re-read is asked for is
// `scheduling.ts`. It is not the ordering rule — which settlement may install is the
// latch's, and this changes none of it. And it is not a timeout: nothing here arms a
// clock, and a read that is simply slow is not abandoned by anyone.

import { GenerationLatch, type CurrentGenerationClaim } from "./generation-latch.js";
import type { SubjectKey } from "./subject-scoped-holder.js";
import {
  useSubjectScopedResource,
  type SubjectScopedTerminalDisposal,
} from "./subject-scoped-resource.js";

/**
 * The one key every scope claims under.
 *
 * A scope IS one read line, so it has exactly one round at a time and there is
 * nothing for a second key to name. The latch is keyed all the same, because a
 * key-less register would be a second register shape for one caller.
 */
const READ_ROUND_KEY = "read";

/**
 * One read: whether its settlement may still install, and the signal that ends it.
 *
 * `CurrentGenerationClaim` is extended rather than held beside, because a caller that
 * could hold one without the other is a caller that can order a settlement it cannot
 * stop, or stop a read whose settlement it cannot order. Both questions are asked of
 * the same read and are answered here together.
 *
 * IT CANNOT GIVE ITS KEY BACK, which is the narrower half the latch publishes for a
 * joiner. The scope took the key and the scope releases it — by superseding on the
 * next round, or by abandoning — so a performer holding a round cannot free a key its
 * successor is relying on.
 */
export interface ReadRound extends CurrentGenerationClaim {
  /**
   * Aborted when this round is superseded, and when its scope is abandoned.
   *
   * Handed to the read itself, never to a mutation. It is a signal and not a
   * predicate, so a read already on the wire is reached rather than only one that
   * has not started.
   */
  readonly signal: AbortSignal;
}

/**
 * One surface's read line, and the two ways a read on it ends.
 *
 * ONE PER `(subject, key)` AND NEVER A SINGLETON. Its whole meaning is that the reads
 * on it belong to one owner; shared between two owners it would let either one end
 * the other's reads, which is the failure this exists to prevent rather than a
 * variation on it.
 *
 * TERMINAL ON `abandon`, and that is a different fact from being superseded. A
 * superseded round makes way for the next one; an abandoned scope has no next one,
 * and a round opened on it is born over. The reading is published so the React
 * binding below can recognise the corpse React's double-mount hands back — which is
 * exactly the `{ dispose, isClosed }` pair `subject-scoped-resource.ts` demands, and
 * the reason this class carries a reading at all.
 */
export class ReadScope {
  readonly #latch = new GenerationLatch();
  /** The controller of the round that is open, or of the last one that ended. */
  #controller: AbortController | undefined;
  #abandoned = false;

  /** Whether this scope is over. True once and never false again. */
  public get isAbandoned(): boolean {
    return this.#abandoned;
  }

  /**
   * Open a round, ending whatever round this scope had open.
   *
   * SUPERSEDING IS THE OPEN, not a call before it: there is no instant at which the
   * line has two live rounds, so a settlement can never be measured against a round
   * that was replaced while it was being measured.
   *
   * An abandoned scope answers a round that is over rather than refusing. A caller
   * that had to branch on "may I read" before every read would write that branch at
   * each call site and eventually not write it; a round whose signal is already
   * aborted reaches the same place through the path the caller already has, and the
   * read never leaves the console because the call door checks the signal before it
   * sends.
   */
  public openRound(): ReadRound {
    if (this.#abandoned) {
      return {
        isCurrent: false,
        settle: (): boolean => false,
        signal: this.#endOpenRound(),
      };
    }
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const claim = this.#latch.supersedeAndClaim(this, READ_ROUND_KEY);
    return {
      get isCurrent(): boolean {
        return claim.isCurrent;
      },
      settle: (apply: () => void): boolean => claim.settle(apply),
      signal: controller.signal,
    };
  }

  /**
   * End this line: the open round aborts, and no later round is live.
   *
   * Idempotent, because the two callers that reach it are React's committed cleanup
   * and the holder's own discard path, and under a double-mount both run against one
   * scope. Superseding the register as well as aborting the signal is not
   * belt-and-braces: an answer already past its `await` never sees the signal move,
   * and the claim it holds is what stops it installing.
   */
  public abandon(): void {
    if (this.#abandoned) {
      return;
    }
    this.#abandoned = true;
    this.#endOpenRound();
    this.#latch.supersedeAll();
  }

  /**
   * Abort whatever round this scope holds and answer its signal, minting the
   * controller where the scope was abandoned before it ever read.
   *
   * One private path so that a scope has exactly one aborted signal to hand out
   * afterwards, however it got there — a fresh controller per abandoned round would
   * be an allocation per read on a line nobody is reading.
   */
  #endOpenRound(): AbortSignal {
    const controller = (this.#controller ??= new AbortController());
    controller.abort();
    return controller.signal;
  }
}

/**
 * How a read finished: with its answer, or with nobody left to give it to.
 *
 * A CLOSED PAIR AND NOT A NULLABLE VALUE, because `undefined` is a legitimate answer
 * to several of the reads this settles and a caller cannot be asked to tell "the wire
 * said nothing" from "nobody is listening". The abandoned arm carries nothing on
 * purpose: there is no answer to carry, and a diagnostic here would be a sentence
 * composed for a surface that is gone.
 */
export type ReadSettlement<TValue> =
  | { readonly status: "settled"; readonly value: TValue }
  | { readonly status: "abandoned" };

/**
 * Settle `pending`, unless `signal` says nobody is waiting for it any more.
 *
 * THE POINT IS THAT IT DOES NOT WAIT. A read that hangs — a scripted reply a scenario
 * never resolves, a daemon that stopped answering — would otherwise hold its caller
 * for the life of the window whatever the owner did, and the abandonment would buy
 * exactly nothing. Racing the abort is what makes the saving real rather than
 * theoretical, and it is why this is a promise combinator and not a flag the caller
 * reads after its `await`.
 *
 * A REJECTION IS STILL THE CALLER'S. This answers the abandoned arm and nothing else:
 * where `pending` rejects first, the rejection travels out of here untouched, so the
 * call door's own reading of a rejected promise is the one that runs. Where the
 * abandonment won and `pending` rejects afterwards, `Promise.race` has already
 * attached to it, so that rejection is handled and reaches no unhandled-rejection
 * sink.
 *
 * `signal` is optional, and its absence is the mutation path rather than a default:
 * a caller that passes none is saying this act has no owner who may leave, and it is
 * awaited exactly as it was before this module existed.
 */
export function settleUnlessAbandoned<TValue>(
  pending: Promise<TValue>,
  signal: AbortSignal | undefined,
): Promise<ReadSettlement<TValue>> {
  if (signal === undefined) {
    return pending.then((value): ReadSettlement<TValue> => ({ status: "settled", value }));
  }
  if (signal.aborted) {
    // The pending call is DROPPED, and dropping a promise is not the same as ignoring
    // its rejection: a read that rejects after its owner left would otherwise reach
    // the host as an unhandled rejection, from a path whose whole claim is that
    // abandonment is quiet. So the rejection is claimed here and discarded.
    void pending.catch(() => undefined);
    return Promise.resolve({ status: "abandoned" });
  }
  // HAND-WRITTEN RATHER THAN `Promise.race`, AND THE REASON IS MICROTASK DEPTH. The
  // race spells this in three lines, but it costs a mapping `then`, the race's own
  // resolution, and an `async` frame around it — four extra turns of the microtask
  // queue on EVERY read the console performs, not only the abandoned ones. This shape
  // costs one: `pending`'s continuation resolves the answer directly. The behaviour is
  // the same and the depth is the difference, which matters because it is paid by the
  // path that works rather than by the exception.
  return new Promise<ReadSettlement<TValue>>((resolve, reject) => {
    const onAbandoned = (): void => {
      resolve({ status: "abandoned" });
    };
    signal.addEventListener("abort", onAbandoned, { once: true });
    pending.then(
      (value) => {
        // `once` retires a listener that FIRED; this retires the one that did not,
        // which is the ordinary path — a read that answered while its owner stayed.
        signal.removeEventListener("abort", onAbandoned);
        resolve({ status: "settled", value });
      },
      (rejection: unknown) => {
        signal.removeEventListener("abort", onAbandoned);
        // The rejection travels out untouched: what a failed read MEANS is the call
        // door's reading, not this one's. Where the abandonment already resolved this
        // promise, rejecting it is inert — and the rejection is still handled here,
        // which is what keeps it off the host's unhandled-rejection path.
        reject(rejection);
      },
    );
  });
}

/**
 * Mint one scope per read line. A module-level function, so the hook below hands the
 * holder a stable identity and the steady render allocates nothing.
 */
function openReadScope(): ReadScope {
  return new ReadScope();
}

/**
 * The disposal a scope has, stated once.
 *
 * TERMINAL AND NOT RELEASING, and the reading beside it is what makes React's
 * double-mount survivable: the committed cleanup abandons the scope, the effect then
 * re-runs against that same abandoned scope, and without `isClosed` the surface would
 * spend the rest of its life reading through a line that can never open a live round
 * again — invisible until something is read.
 */
const READ_SCOPE_DISPOSAL: SubjectScopedTerminalDisposal<ReadScope> = {
  dispose: (scope: ReadScope): void => {
    scope.abandon();
  },
  isClosed: (scope: ReadScope): boolean => scope.isAbandoned,
};

/**
 * Hold one read line per `(subject, key)`, and end it however its render ended.
 *
 * `useSubjectScopedResource` OWNS EVERY HARD PART OF THIS, which is why the binding is
 * four lines and not a lifetime of its own. A scope opened by a render React throws
 * away is closed by the holder inside that render; one the subject moved out from
 * under is closed by the effect that held it; one the double-mount disposed is
 * recognised and re-minted. Writing any of that again here would be a second
 * disposal rule for a family that has one.
 *
 * The scope is returned bare rather than as its holder's state, because nothing
 * renders a read scope: it is handed to a read and read by nobody.
 */
export function useReadScope(subject: object, key: SubjectKey): ReadScope {
  return useSubjectScopedResource(subject, key, openReadScope, READ_SCOPE_DISPOSAL).value;
}
