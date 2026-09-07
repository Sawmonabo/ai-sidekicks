// The replies a scenario has parked on its frozen clock, and the bound on how many.
//
// SPLIT OUT OF `scenario-engine.ts` BECAUSE IT IS THE OTHER JOB THAT FILE WAS DOING.
// The engine owns scenario TIME — one clock, one tick, one delivered-beat cursor, and
// the replay a late subscriber gets. This module owns SCHEDULING against that time:
// which parked replies are due, in what order they settle, and what happens to the
// ones that are still parked when the engine goes away. The two meet at exactly two
// calls, `releaseThrough` on every advance and `abandonAll` on teardown, which is what
// makes the seam a seam rather than a cut through the middle of one thing.
//
// NOTHING HERE READS A CLOCK. Every method takes the elapsed instant it is judging
// against, because the engine holds the only clock in fixture mode and a second reader
// of it here would be a second opinion about what time it is — the property the engine
// exists to keep. This module knows about ordering and about a cap; it does not know
// when now is.

/**
 * How a held reply ended.
 *
 * Three outcomes rather than a promise that resolves or hangs, because two of
 * them are refusals the caller has to render: an engine torn down under a request
 * and a backlog that is already full both leave the caller with nothing to show,
 * and a promise that never settles leaves a surface loading for the life of the
 * window. The engine reports which; naming the refusal belongs to the bridge.
 */
export type ScenarioReplyOutcome = "due" | "abandoned" | "backlog-full";

/** One reply parked until the frozen clock reaches its tick. */
interface HeldScenarioReply {
  readonly dueAtMs: number;
  readonly settle: (outcome: ScenarioReplyOutcome) => void;
}

/**
 * The replies a scenario is holding, and the bound on how many.
 *
 * Its own class rather than an array field on the engine because it owns a rule
 * the engine does not otherwise have: entries leave in DUE order, not in call
 * order, so two calls made together with different scripted latencies settle in
 * the order a real transport would settle them. Keeping that in one place is what
 * stops `advance` from growing a second sort.
 *
 * INTRA-FAMILY AND OFF THE DOOR. The engine is its only reader, and a door line for a
 * class one sibling constructs would publish an edge into the engine's own internals to
 * every reader of `scenario-runtime/`.
 */
export class HeldReplyQueue {
  readonly #held: HeldScenarioReply[] = [];
  readonly #cap: number;

  public constructor(cap: number) {
    this.#cap = cap;
  }

  public get heldCount(): number {
    return this.#held.length;
  }

  /** Park one reply. `false` when the queue is already at its cap. */
  public hold(dueAtMs: number, settle: (outcome: ScenarioReplyOutcome) => void): boolean {
    if (this.#held.length >= this.#cap) {
      return false;
    }
    this.#held.push({ dueAtMs, settle });
    return true;
  }

  /**
   * Settle every reply due at or before `elapsedMs`, earliest first.
   *
   * The entries are removed BEFORE any of them is settled, so a continuation that
   * issues another delayed call cannot be released by the same pass that released
   * the call it came from. `sort` is stable, so replies sharing a due tick settle
   * in the order they were made.
   */
  public releaseThrough(elapsedMs: number): void {
    if (this.#held.length === 0) {
      // The common case by far — every advance of a scenario that scripts no
      // latency reaches here — and it allocates nothing.
      return;
    }
    const due: HeldScenarioReply[] = [];
    const stillHeld: HeldScenarioReply[] = [];
    for (const reply of this.#held) {
      (reply.dueAtMs <= elapsedMs ? due : stillHeld).push(reply);
    }
    if (due.length === 0) {
      return;
    }
    this.#held.length = 0;
    this.#held.push(...stillHeld);
    due.sort((left, right) => left.dueAtMs - right.dueAtMs);
    for (const reply of due) {
      reply.settle("due");
    }
  }

  /** Settle every held reply as abandoned. For teardown, and final. */
  public abandonAll(): void {
    const abandoned = this.#held.splice(0, this.#held.length);
    for (const reply of abandoned) {
      reply.settle("abandoned");
    }
  }
}
