// Each pane kind's width and the stacked terminal's height as a person last set them, kept for
// this install: a width dragged in one session is the width that pane opens at in every other,
// and after a restart. One durable record in the global partition under the `layout` class,
// `{ <kind>: { widthPx }, terminal: { widthPx, stackedHeightPx } }`, written on each set, which
// an edge makes on pointer-up. A read that failed opens every pane at its opening width and
// keeps the refusal, so the session screen says so in one line.

import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { isWireRecord } from "#renderer/lib/wire/record.js";
import { isPaneKind, type BlockPaneKind } from "#renderer/routing/panes/kinds.js";
import { DurableViewState } from "#renderer/store/persistence/durable-view-state.js";
import type { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import type { Unsubscribe } from "#shared/preload-api.js";

/** The record key inside the global partition. Identifier-shaped, as the store requires. */
const KEPT_PANE_SIZES_KEY = "pane-sizes";

/** The member a kind's width is kept under. */
const WIDTH_MEMBER = "widthPx";

/** The member the stacked terminal's height is kept under, beside the terminal's width. */
const STACKED_HEIGHT_MEMBER = "stackedHeightPx";

/** The sizes a pane layout draws from, read off the kept record. */
export interface PaneSizes {
  /** Each kind's width a person set, in CSS px; absent at its opening width. */
  readonly widthsPx: Readonly<Partial<Record<BlockPaneKind, number>>>;
  /** The stacked terminal's height a person set, in CSS px; `undefined` at its third. */
  readonly terminalHeightPx: number | undefined;
}

/** The kept record: each pane kind's sizes, in CSS px, only those a person set. */
type KeptPaneSizesRecord = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** The sizes before any was set or read: every pane at its opening size. */
const NO_KEPT_SIZES: KeptPaneSizesRecord = {};

/** The kept pane sizes for this install, durable. One per durable store. */
export class KeptPaneSizes {
  readonly #state: DurableViewState<KeptPaneSizesRecord>;
  #sizesOf: { readonly record: KeptPaneSizesRecord; readonly sizes: PaneSizes } | undefined;

  public constructor(store: UiStateStore) {
    this.#state = new DurableViewState<KeptPaneSizesRecord>({
      store,
      key: KEPT_PANE_SIZES_KEY,
      valueClass: "layout",
      initial: NO_KEPT_SIZES,
      narrow: narrowKeptPaneSizes,
    });
  }

  /** The sizes now: the same object until the record changes, for `useSyncExternalStore`. */
  public get sizes(): PaneSizes {
    const record = this.#state.value;
    if (this.#sizesOf?.record !== record) {
      this.#sizesOf = { record, sizes: sizesOf(record) };
    }
    return this.#sizesOf.sizes;
  }

  /** The last refusal: a read that failed, or the last write the store refused. */
  public get lastRefusal(): Refusal | undefined {
    return this.#state.lastRefusal;
  }

  /** Be told when the sizes or the last refusal change. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#state.subscribe(sink);
  }

  /** Reads the kept record once; a size set before it lands is not overwritten. */
  public async hydrate(): Promise<void> {
    await this.#state.hydrate();
  }

  /** Released when the durable store is replaced. Terminal. */
  public dispose(): void {
    this.#state.dispose();
  }

  /** Keeps one kind's width in CSS px, or returns it to its opening width with `undefined`. */
  public setPaneWidth(kind: BlockPaneKind, widthPx: number | undefined): void {
    this.#setMember(kind, WIDTH_MEMBER, widthPx);
  }

  /** Keeps the stacked terminal's height in CSS px, or returns it to a third with `undefined`. */
  public setTerminalHeight(heightPx: number | undefined): void {
    this.#setMember("terminal", STACKED_HEIGHT_MEMBER, heightPx);
  }

  #setMember(kind: BlockPaneKind, member: string, sizePx: number | undefined): void {
    const record = this.#state.value;
    if (record[kind]?.[member] === sizePx) {
      return;
    }
    const kindSizes: Record<string, number> = { ...record[kind] };
    if (sizePx === undefined) {
      delete kindSizes[member];
    } else {
      kindSizes[member] = sizePx;
    }
    const next: Record<string, Readonly<Record<string, number>>> = { ...record };
    if (Object.keys(kindSizes).length === 0) {
      delete next[kind];
    } else {
      next[kind] = kindSizes;
    }
    // Not awaited: a refused write is kept as the last refusal, which the screen reads.
    void this.#state.commit(next);
  }
}

/** The sizes a record holds, read by kind. */
function sizesOf(record: KeptPaneSizesRecord): PaneSizes {
  const widthsPx: Partial<Record<BlockPaneKind, number>> = {};
  for (const [kind, kindSizes] of Object.entries(record)) {
    const widthPx = kindSizes[WIDTH_MEMBER];
    if (isPaneKind(kind) && kind !== "transcript" && widthPx !== undefined) {
      widthsPx[kind] = widthPx;
    }
  }
  return { widthsPx, terminalHeightPx: record["terminal"]?.[STACKED_HEIGHT_MEMBER] };
}

/**
 * A kept record narrowed to what this build draws: a block pane kind's positive sizes under the
 * members it keeps. A record holding anything else was not written by this build and is set
 * aside whole.
 */
function narrowKeptPaneSizes(raw: unknown): KeptPaneSizesRecord | undefined {
  if (!isWireRecord(raw)) {
    return undefined;
  }
  const record: Record<string, Readonly<Record<string, number>>> = {};
  for (const [kind, kindSizes] of Object.entries(raw)) {
    if (!isPaneKind(kind) || kind === "transcript" || !isWireRecord(kindSizes)) {
      return undefined;
    }
    const sizes: Record<string, number> = {};
    for (const [member, sizePx] of Object.entries(kindSizes)) {
      const isKeptMember =
        member === WIDTH_MEMBER || (kind === "terminal" && member === STACKED_HEIGHT_MEMBER);
      if (!isKeptMember || typeof sizePx !== "number" || !(sizePx > 0)) {
        return undefined;
      }
      sizes[member] = sizePx;
    }
    record[kind] = sizes;
  }
  return record;
}
