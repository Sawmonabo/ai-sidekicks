// Session replay — re-watching a session at time scale, from rows already loaded.
//
// `Spec-023 §The four bars`, Richness, names "session replay at time scale" among the
// console's signature surfaces, and `Spec-023 §The fixture bridge` says the scenarios
// "double as demo reels". THE CONTROL IS THIS MODULE'S, because no committed document
// states it: re-watch any session at time scale from the rows already loaded — play,
// pause, three speeds, scrub, jump-to-seam, and "replay from here" on every row.
//
// FOUR RULES, AND EACH IS A WAY A REPLAY COULD LIE:
//
//   • **It mints no wire method.** Replay reads the loaded window
//     and nothing else; a live gap-fill re-subscribes at the last good cursor
//     through the timeline subscription the ledger already holds, which is a read
//     the console already performs rather than an operation replay invents.
//   • **It never scrubs past the loaded window.** The position is clamped to the
//     window's own span, so the head and the tail of a replay are the head and the
//     tail of what is actually loaded.
//   • **It never claims stream granularity for a live replay.** A replay of rows
//     the daemon delivered is a replay at TURN granularity, because the deltas
//     between turns were never persisted; only a fixture scenario, which records
//     its own deltas, replays at stream granularity. The label is a value on the
//     model, so the surface renders what this is rather than what it wishes it
//     were.
//   • **It arms one timeout at a time, through the console clock.** No interval,
//     and every advance is a `scheduleTimeout` on the injected clock — which is the
//     frozen clock in the fixture and in every test, so a replay is deterministic
//     rather than wall-clock-dependent.

import type { ConsoleClock, ScheduledHandle } from "../../core/index.js";
import { REPLAY_FRAME_INTERVAL_MS } from "./constants.js";
import type { LedgerSeam } from "./seams.js";

/**
 * The speeds replay offers. Closed at three, and the tuple is the declaration —
 * the presets are 1×, 8×, and 32×, and a control that rendered a fourth
 * would be offering a speed the model cannot run.
 */
export const REPLAY_SPEEDS = [1, 8, 32] as const;

export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/**
 * What the replay is doing. Four states, closed.
 *
 * `at-tail` is distinct from `paused` because the two offer different next moves:
 * a paused replay resumes, and a replay at the tail resumes FOLLOWING — the live
 * stream takes over and there is nothing left to play.
 */
export const REPLAY_STATES = ["idle", "playing", "paused", "at-tail"] as const;

export type ReplayState = (typeof REPLAY_STATES)[number];

/**
 * How finely the replay can re-animate. Two values, and the distinction is a claim
 * about the DATA rather than a rendering preference.
 */
export const REPLAY_GRANULARITIES = ["turn", "stream"] as const;

export type ReplayGranularity = (typeof REPLAY_GRANULARITIES)[number];

/** One row the replay can reveal, reduced to what playback orders by. */
export interface ReplayRow {
  readonly rowId: string;
  /** Wire-verbatim ISO instant. Playback orders by this and by nothing else. */
  readonly occurredAt: string;
}

/** What the replay control renders. */
export interface ReplayPosition {
  readonly state: ReplayState;
  readonly speed: ReplaySpeed;
  readonly granularity: ReplayGranularity;
  /** Milliseconds from the window's first row. Always inside the loaded span. */
  readonly elapsedMs: number;
  /** The window's whole span, in milliseconds. Zero for an empty or single-row window. */
  readonly spanMs: number;
  /** The instant the position names, ISO, for the mono timestamp on the control. */
  readonly positionIso: string | undefined;
  /** Rows revealed at this position, in `occurredAt` order. */
  readonly revealedRowIds: readonly string[];
}

export interface ReplayEngineOptions {
  readonly clock: ConsoleClock;
  readonly rows: readonly ReplayRow[];
  /**
   * `"stream"` only for a fixture scenario replaying its own recorded deltas.
   * A live replay is `"turn"`, and defaults to it: claiming the finer granularity
   * by omission is exactly the lie the header's fourth rule forbids.
   */
  readonly granularity?: ReplayGranularity;
  /** Called whenever the position changes, so a surface can re-render. */
  readonly onPositionChange?: (position: ReplayPosition) => void;
  /** Advance step in real milliseconds. One value, one home: `constants.ts`. */
  readonly frameIntervalMs?: number;
}

/**
 * The replay engine.
 *
 * A class with private fields, holding the one timeout it may arm. Everything it
 * decides is derivable from the row window and the position, so a surface renders
 * `position()` and stores nothing of its own.
 */
export class ReplayEngine {
  readonly #clock: ConsoleClock;
  readonly #rowsInOrder: readonly ReplayRow[];
  readonly #offsetsMs: readonly number[];
  /**
   * Where each row sits in the ordered window, keyed by its id.
   *
   * Built once, because every caller that names a row — a seam jump, "replay from
   * here", the timestamp the control renders — otherwise scans the window, and the
   * seam jump scanned it once per seam on every press. A repeated row id is a
   * projection defect; the first occurrence wins, which is the row the ordering
   * put first.
   */
  readonly #rowIndexByRowId: ReadonlyMap<string, number>;
  readonly #granularity: ReplayGranularity;
  readonly #onPositionChange: ((position: ReplayPosition) => void) | undefined;
  readonly #frameIntervalMs: number;
  readonly #spanMs: number;

  #state: ReplayState = "idle";
  #speed: ReplaySpeed = 1;
  #elapsedMs = 0;
  #armedHandle: ScheduledHandle | undefined;
  #disposed = false;

  public constructor(options: ReplayEngineOptions) {
    this.#clock = options.clock;
    this.#granularity = options.granularity ?? "turn";
    this.#onPositionChange = options.onPositionChange;
    this.#frameIntervalMs = options.frameIntervalMs ?? REPLAY_FRAME_INTERVAL_MS;

    // Ordered by `occurredAt`, which is what playback reveals in — a
    // sequence order would be the log's order, and the two differ wherever the
    // daemon admitted rows out of wall-clock order.
    const rowsInOrder = [...options.rows].sort(
      (left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
    );
    const firstMs = rowsInOrder.length === 0 ? 0 : Date.parse(rowsInOrder[0]?.occurredAt ?? "");
    const offsets = rowsInOrder.map((row) => {
      const parsed = Date.parse(row.occurredAt);
      // An unparseable instant lands at the head rather than at `NaN`: the row is
      // still part of the session and dropping it would make replay show fewer
      // rows than the ledger does.
      return Number.isNaN(parsed) ? 0 : parsed - firstMs;
    });
    const rowIndexByRowId = new Map<string, number>();
    for (const [index, row] of rowsInOrder.entries()) {
      if (!rowIndexByRowId.has(row.rowId)) {
        rowIndexByRowId.set(row.rowId, index);
      }
    }
    this.#rowsInOrder = rowsInOrder;
    this.#offsetsMs = offsets;
    this.#rowIndexByRowId = rowIndexByRowId;
    this.#spanMs = offsets.length === 0 ? 0 : Math.max(...offsets);
  }

  /** Everything the control renders. */
  public position(): ReplayPosition {
    return {
      state: this.#state,
      speed: this.#speed,
      granularity: this.#granularity,
      elapsedMs: this.#elapsedMs,
      spanMs: this.#spanMs,
      positionIso: this.#positionIso(),
      revealedRowIds: this.#revealedRowIds(),
    };
  }

  /** Start or resume playback. A replay already at the tail restarts from the head. */
  public play(): void {
    if (this.#disposed) {
      return;
    }
    if (this.#state === "at-tail") {
      this.#elapsedMs = 0;
    }
    this.#state = "playing";
    this.#arm();
    this.#notify();
  }

  /** Hold the position. The armed frame is dropped rather than left to fire. */
  public pause(): void {
    if (this.#state !== "playing") {
      return;
    }
    this.#state = "paused";
    this.#cancelArmed();
    this.#notify();
  }

  /** Choose a speed. Takes effect on the next frame; the position does not move. */
  public setSpeed(speed: ReplaySpeed): void {
    this.#speed = speed;
    this.#notify();
  }

  /**
   * Move to a position, clamped to the loaded window.
   *
   * The header's second rule — never scrub past the loaded window without loading it
   * first: the
   * clamp is the enforcement, and a caller that wants more window asks the ledger
   * to load earlier rows first.
   *
   * AND `at-tail` IS A PROPERTY OF THE POSITION RATHER THAN OF HOW IT WAS REACHED.
   * It used to be reachable only by ADVANCING into it, so a scrub to the very end —
   * the dock's slider dragged all the way right, a "replay from here" landing on the
   * window's last row, or a walk re-minted at the end after a chapter disclosure —
   * settled `paused`, and the dock then offered to resume a replay with nothing left
   * to play. The two states offer different next moves, which is the whole reason
   * they are separate, so deciding between them from the position is the only way
   * the offer can be right.
   *
   * A PLAYING REPLAY IS LEFT PLAYING. Its own next frame settles it at the tail, and
   * flipping the state here would strand the armed frame this engine has out.
   */
  public scrubTo(elapsedMs: number): void {
    this.#elapsedMs = Math.min(Math.max(0, elapsedMs), this.#spanMs);
    if (this.#state !== "playing") {
      this.#state = this.#elapsedMs >= this.#spanMs ? "at-tail" : "paused";
    }
    this.#notify();
  }

  /**
   * Replay from one row — the `"replay from here"` interaction
   * `Spec-023 §Signature Feature Composition Sketches`' Timeline View names.
   *
   * Client-local scrub navigation within the loaded window — deliberately not a
   * deep link and not a new deep-link kind, which is what that offer says in
   * terms. Returns whether the row was in the window, so a caller can render the
   * absence rather than silently doing nothing.
   */
  public replayFrom(rowId: string): boolean {
    const offsetMs = this.#offsetMsOf(rowId);
    if (offsetMs === undefined) {
      return false;
    }
    this.scrubTo(offsetMs);
    return true;
  }

  /**
   * Jump to the next seam after the current position, or `undefined` at the end.
   *
   * Takes the seams rather than deriving them: `seams.ts` owns that vocabulary and
   * a second classifier here would be the drift the structure rules forbid.
   *
   * NEXT is the chronologically nearest and not the first in the list. `seams()`
   * produces its output in log order and sorts nothing, while replay orders rows by
   * `occurredAt`, and the two differ wherever the daemon admitted rows out of
   * wall-clock order. Taking the first in log order there jumps PAST a nearer seam
   * — and because the jump scrubs, the skipped seam is then behind the elapsed
   * position and no later press can ever reach it. The comparison is strict, so
   * seams sharing an instant are taken in the order the log recorded them.
   */
  public jumpToNextSeam(seams: readonly LedgerSeam[]): LedgerSeam | undefined {
    let nearestSeam: LedgerSeam | undefined;
    let nearestOffsetMs = Number.POSITIVE_INFINITY;
    for (const seam of seams) {
      const offsetMs = this.#offsetMsOf(seam.rowId);
      if (offsetMs === undefined || offsetMs <= this.#elapsedMs || offsetMs >= nearestOffsetMs) {
        continue;
      }
      nearestSeam = seam;
      nearestOffsetMs = offsetMs;
    }
    if (nearestSeam === undefined) {
      return undefined;
    }
    this.scrubTo(nearestOffsetMs);
    return nearestSeam;
  }

  /**
   * Stop, terminally.
   *
   * A pane that unmounts mid-replay must not be able to re-arm from a late frame,
   * which is `store/scheduling.ts`' rule for the two schedulers the console owns
   * and holds here for the same reason.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#cancelArmed();
    this.#state = "idle";
  }

  /** Whether a frame is armed. The idle-CPU budget's question, answerable. */
  public get isArmed(): boolean {
    return this.#armedHandle !== undefined;
  }

  /** Where a row sits on the replay clock, or `undefined` for a row not in the window. */
  #offsetMsOf(rowId: string): number | undefined {
    const index = this.#rowIndexByRowId.get(rowId);
    return index === undefined ? undefined : (this.#offsetsMs[index] ?? 0);
  }

  #positionIso(): string | undefined {
    const revealed = this.#revealedRowIds();
    const lastRevealedId = revealed[revealed.length - 1];
    if (lastRevealedId === undefined) {
      return this.#rowsInOrder[0]?.occurredAt;
    }
    const index = this.#rowIndexByRowId.get(lastRevealedId);
    return index === undefined ? undefined : this.#rowsInOrder[index]?.occurredAt;
  }

  #revealedRowIds(): readonly string[] {
    const revealed: string[] = [];
    for (const [index, row] of this.#rowsInOrder.entries()) {
      if ((this.#offsetsMs[index] ?? 0) <= this.#elapsedMs) {
        revealed.push(row.rowId);
      }
    }
    return revealed;
  }

  #arm(): void {
    if (this.#disposed || this.#armedHandle !== undefined) {
      return;
    }
    this.#armedHandle = this.#clock.scheduleTimeout(() => {
      this.#armedHandle = undefined;
      this.#advance();
    }, this.#frameIntervalMs);
  }

  #advance(): void {
    if (this.#state !== "playing") {
      return;
    }
    this.#elapsedMs = Math.min(this.#spanMs, this.#elapsedMs + this.#frameIntervalMs * this.#speed);
    if (this.#elapsedMs >= this.#spanMs) {
      // At the tail, following resumes — so the engine stops arming rather than
      // spinning a frame that would advance nothing.
      this.#state = "at-tail";
      this.#notify();
      return;
    }
    this.#arm();
    this.#notify();
  }

  #cancelArmed(): void {
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
  }

  #notify(): void {
    this.#onPositionChange?.(this.position());
  }
}
