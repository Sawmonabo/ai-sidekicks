// The replies a scenario has parked on its frozen clock, and the bound on how many. A
// `ScenarioReply` carrying `afterMs` is unanswered until the caller moves the clock, and holding
// it beside the engine keeps that clock the single source of scenario time. The engine owns time;
// this module owns scheduling against it: which parked replies are due, in what order they settle,
// and what happens to those still parked at teardown. It reads no clock; every method takes the
// elapsed instant it judges against.

/**
 * How a held reply ended. Three outcomes rather than a promise that hangs: an abandoned reply
 * or a full backlog leaves the caller nothing to show, and a promise that never settles leaves a
 * view loading for the life of the window. The bridge names the refusal.
 */
export type ScenarioReplyOutcome = "due" | "abandoned" | "backlog-full";

/**
 * The replies a scenario is holding, and the bound on how many. Entries leave in due order, not
 * call order, so calls with different scripted latencies settle as a real transport would. Used
 * by the engine alone.
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
   * Settle every reply due at or before `elapsedMs`, earliest first. Entries are removed before
   * any is settled, so a continuation that issues another delayed call is not released by the
   * same pass. The sort is stable, so replies sharing a tick settle in call order.
   */
  public releaseThrough(elapsedMs: number): void {
    if (this.#held.length === 0) {
      // The common case (a scenario with no latency); allocates nothing.
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

/** One reply parked until the frozen clock reaches its tick. */
interface HeldScenarioReply {
  readonly dueAtMs: number;
  readonly settle: (outcome: ScenarioReplyOutcome) => void;
}
