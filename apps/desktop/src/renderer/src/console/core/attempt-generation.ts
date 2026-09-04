// Which round of work is current, and what a late reply from an older one may do.
//
// THE PROBLEM EVERY HOLDER IN THIS CONSOLE HAS
//
// Nothing behind the bridge is cancellable. A read, a write, or a subscription
// opening is started and then either settles or does not, and the console cannot
// stop it — so every holder that can be asked a second question before the first
// one answered has to decide what the FIRST answer is allowed to do when it lands.
// Installing it is wrong in every case: it is the answer to a question that has
// been replaced, and installing it puts a value on screen that nothing on the wire
// currently claims. Rejecting the whole object is wrong too, because a React
// effect's cleanup runs between the two invocations strict mode makes of one
// effect, and a holder that treated a teardown as terminal would answer the second
// invocation with a dead object.
//
// So the answer is a MONOTONIC COUNTER and not an `AbortController`: a superseded
// reply is IGNORED, and claiming that its call was stopped would be a claim this
// console cannot honour. That counter, its capture, its predicate, and its
// non-terminal invalidation were written five times across four families, each
// with its own field name and its own paragraph saying this. It is written here
// once instead, because the one place five copies would drift is the predicate —
// and a drifted predicate is a stale value on screen that every test still passes.
//
// THE TWO SHAPES IT SERVES, AND WHY ONE CLASS COVERS BOTH
//
//   • **A new attempt supersedes the one before it** — a second write, a re-opened
//     subscription, a mutation pressed twice. That caller takes `begin()`, which
//     invalidates whatever was in flight and hands back the round it just started.
//   • **A local act supersedes a read already in flight** — a durable hydration
//     answering with the value from before the act that raced it. That caller takes
//     `current()` where it starts the read and `supersedeAll()` where the act
//     happens, so the read is the thing invalidated rather than the thing starting.
//
// They are the same mechanism with the roles named differently, which is why the
// class carries both entry points rather than two classes carrying one each.
//
// WHAT THIS IS NOT. It is not a scheduler — a burst of requests collapsing into one
// read is `store/scheduling.ts`, and asking this object for that would get a caller
// N calls where it wanted one. It is not a latch either: it refuses nothing and
// admits nothing, it only says which round a caller is on.

declare const attemptBrand: unique symbol;

/**
 * One captured round, comparable only against the generation that minted it.
 *
 * Branded rather than a bare `number` so a predicate cannot be handed a count, an
 * index, or a timestamp that happens to be in scope: the only way to obtain one is
 * to ask the generation, which is what makes the comparison mean anything.
 */
export type Attempt = number & { readonly [attemptBrand]: "console attempt" };

/**
 * The rounds one holder is on, and which of them is current.
 *
 * Deliberately holds no value, no emitter, and no timer: a holder's state, its
 * subscribers, and its teardown are its own, and folding them in here would make
 * this the base class of five unrelated objects rather than one thing they share.
 */
export class AttemptGeneration {
  #current = 0 as Attempt;

  /**
   * Supersede everything in flight and claim the round that follows.
   *
   * For the caller whose new attempt REPLACES the previous one. The returned round
   * is the only one {@link isCurrent} will answer `true` for until the next call.
   */
  public begin(): Attempt {
    this.supersedeAll();
    return this.#current;
  }

  /**
   * Claim the round already running, superseding nothing.
   *
   * For the caller whose work is invalidated by something else — a read that a
   * later local act supersedes, or one of several writes sharing one round.
   */
  public current(): Attempt {
    return this.#current;
  }

  /** Whether `attempt` is still the round this generation is on. */
  public isCurrent(attempt: Attempt): boolean {
    return attempt === this.#current;
  }

  /**
   * Invalidate every attempt in flight without claiming a new one.
   *
   * NEVER TERMINAL, and that is the property: this is what a teardown calls, and a
   * holder whose teardown killed it would be dead for the rest of a mount's life
   * after strict mode's first cleanup. A caller that also has a genuinely terminal
   * state keeps its own flag for it — being disposed and being superseded are two
   * different facts, and only one of them is reversible.
   */
  public supersedeAll(): void {
    this.#current = (this.#current + 1) as Attempt;
  }
}
