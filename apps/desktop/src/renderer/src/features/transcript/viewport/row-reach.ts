// The rows within the drawn band's reach, handed to the feed, which parses the command outputs of
// those rows alone, at once for the rows in view. Each walk of the band hands over the rows it
// reached. A landing waiting for its screen adds the rows it will show, which stay within reach
// until the band next walks after the landing ends, by then over the rows it landed on. A walk that
// left a row coming into the band undrawn until its output is parsed is walked again once a row's
// work lands.

import type { Unsubscribe } from "#shared/preload-api.js";

/** What the feed answers the band about its rows' command outputs. */
export interface RowOutputParses {
  /** Hands over the rows within the band's reach and, among them, the rows in view, by key. */
  observeReach(rowKeys: ReadonlySet<string>, viewRowKeys: ReadonlySet<string>): void;
  /** Whether a row's command output, if it draws one, is parsed whole. */
  isOutputParsed(rowKey: string): boolean;
}

/** Dependencies of a `ViewportRowReach`. */
export interface ViewportRowReachOptions {
  /** The key of the row at an index of the rows the viewport holds. */
  readonly rowKeyAt: (index: number) => string | undefined;
  /** The feed's answers; a frame given none parses nothing and draws every row it reaches. */
  readonly outputs: RowOutputParses | undefined;
  /** Hear each time any row's work lands. Returns the unsubscribe. */
  readonly subscribeToRowWork: (listener: () => void) => Unsubscribe;
  /** Walk the band again on the next render, which mounts the rows whose work landed. */
  readonly redrawBand: () => void;
}

/** What the band and a waiting landing reach, handed to the feed as one set of rows. */
export class ViewportRowReach {
  readonly #rowKeyAt: (index: number) => string | undefined;
  readonly #outputs: RowOutputParses | undefined;
  readonly #subscribeToRowWork: (listener: () => void) => Unsubscribe;
  readonly #redrawBand: () => void;
  #bandRowKeys: ReadonlySet<string> = new Set<string>();
  #viewRowKeys: ReadonlySet<string> = new Set<string>();
  #landingRowKeys: readonly string[] = [];
  /** Set while a walk waits on a row's work, to stop hearing it. */
  #stopHearingRowWork: Unsubscribe | undefined;

  public constructor(options: ViewportRowReachOptions) {
    this.#rowKeyAt = options.rowKeyAt;
    this.#outputs = options.outputs;
    this.#subscribeToRowWork = options.subscribeToRowWork;
    this.#redrawBand = options.redrawBand;
  }

  /** Whether the command output of the row at an index, if it draws one, is parsed whole. */
  public isOutputParsedAt(index: number): boolean {
    const rowKey = this.#rowKeyAt(index);
    return rowKey === undefined || this.#outputs?.isOutputParsed(rowKey) !== false;
  }

  /** One walk of the band: the indexes of the rows within its reach, and of the rows in view. */
  public reachBand(indexes: readonly number[], viewIndexes: readonly number[]): void {
    this.#bandRowKeys = this.#rowKeysAt(indexes);
    this.#viewRowKeys = this.#rowKeysAt(viewIndexes);
    this.#handOver();
  }

  /**
   * The rows a waiting landing will show, or none once it ends; an end hands nothing over, so its
   * rows stay within reach until the band's next walk.
   */
  public reachLanding(rowKeys: readonly string[]): void {
    this.#landingRowKeys = rowKeys;
    if (rowKeys.length > 0) {
      this.#handOver();
    }
  }

  /** A walk left a row coming into the band undrawn: the band is walked again once work lands. */
  public awaitRowWork(): void {
    if (this.#stopHearingRowWork !== undefined) {
      return;
    }
    this.#stopHearingRowWork = this.#subscribeToRowWork(() => {
      this.#stopHearing();
      this.#redrawBand();
    });
  }

  /** Terminal: no row's work is heard after it. */
  public dispose(): void {
    this.#stopHearing();
  }

  #rowKeysAt(indexes: readonly number[]): ReadonlySet<string> {
    const rowKeys = new Set<string>();
    for (const index of indexes) {
      const rowKey = this.#rowKeyAt(index);
      if (rowKey !== undefined) {
        rowKeys.add(rowKey);
      }
    }
    return rowKeys;
  }

  #handOver(): void {
    this.#outputs?.observeReach(
      this.#landingRowKeys.length === 0
        ? this.#bandRowKeys
        : new Set([...this.#bandRowKeys, ...this.#landingRowKeys]),
      this.#viewRowKeys,
    );
  }

  #stopHearing(): void {
    this.#stopHearingRowWork?.();
    this.#stopHearingRowWork = undefined;
  }
}
