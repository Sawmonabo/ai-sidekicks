// Where the tables of a markdown body drawn whole sit in the conversation scroller. The body has no
// window over its blocks, so a table measures its place from the body itself: the body's top is its
// row's start and its place in the row, read whenever the body is laid out anew, which also tells
// its tables to read their own place in it again. A body no table listens to reads nothing when it
// is laid out, only when asked, so a reply without a long table costs no layout read. A table that
// starts to listen after such a layout hears of it in the body's next report, before it paints.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { type MarkdownWindowViewport } from "../block-window/context.js";
import { isSameBodyType, readMarkdownBodyType, type MarkdownBodyType } from "../body-type.js";
import { blockSourceStartOf, type MarkdownBodyBlocksSnapshot } from "../body-blocks.js";
import { offsetInRowPx } from "../scroller-window.js";
import { type TableBodyPlacement, type TablePlacementChange } from "./context.js";
import { warmIdeographFallback } from "./ideograph-fallback-warm.js";

/** The blocks a body drawn whole counts its tables' text in. */
export type FlowBodyBlocks = Pick<
  MarkdownBodyBlocksSnapshot,
  "settledBlocks" | "volatileTail" | "definitionPreamble"
>;

/** The placement a body drawn whole gives its tables, observing the body's size. */
export class FlowBodyPlacement implements TableBodyPlacement {
  readonly #viewport: MarkdownWindowViewport;
  readonly #rowKey: string;
  readonly #placementChanges = new Emitter<TablePlacementChange>("flow body placement change");
  #blocks: FlowBodyBlocks;
  #bodyTextLength: number;
  #bodyElement: HTMLElement | undefined;
  #stopObservingBody: Unsubscribe | undefined;
  #bodyType: MarkdownBodyType | undefined;
  /** How far the body's top sits below its row's, read each time the body is laid out. */
  #bodyOffsetInRowPx = 0;
  /** The body's content width as its last observation reported it, in CSS pixels. */
  #observedInlineSizePx = 0;
  /** Whether the body was laid out anew since its type and place were last read. */
  #isUnread = false;
  /** The row's last known top, kept while the viewport lets the row go. */
  #rowStartPx = 0;

  /** The body's element, observed for every change of its size: a block above a table grew. */
  public readonly attachBody = (element: HTMLElement | null): void => {
    this.#stopObservingBody?.();
    this.#stopObservingBody = undefined;
    this.#bodyElement = element ?? undefined;
    if (element !== null) {
      warmIdeographFallback(element);
      this.#observeBody(element);
    }
  };

  /** `viewport` and `rowKey` are held for the body's life. */
  public constructor(
    viewport: MarkdownWindowViewport,
    rowKey: string,
    blocks: FlowBodyBlocks,
    bodyTextLength: number,
  ) {
    this.#viewport = viewport;
    this.#rowKey = rowKey;
    this.#blocks = blocks;
    this.#bodyTextLength = bodyTextLength;
  }

  public get bodyType(): MarkdownBodyType | undefined {
    this.#readUnreadBody();
    return this.#bodyType;
  }

  public get ownerDocument(): Document | undefined {
    return this.#bodyElement?.ownerDocument;
  }

  public get rowKey(): string {
    return this.#rowKey;
  }

  public get definitionPreamble(): string {
    return this.#blocks.definitionPreamble;
  }

  /** Takes the body's blocks and its text's length for this frame. */
  public setBlocks(blocks: FlowBodyBlocks, bodyTextLength: number): void {
    this.#blocks = blocks;
    this.#bodyTextLength = bodyTextLength;
  }

  public blockSourceStart(index: number): number {
    return blockSourceStartOf(this.#blocks, this.#bodyTextLength, index);
  }

  /** A settled block's fingerprint; `undefined` for the streaming tail. */
  public blockFingerprint(index: number): string | undefined {
    return this.#blocks.settledBlocks[index]?.fingerprint;
  }

  /** Every table here measures its place from the body. */
  public anchorOf(): Element | null {
    return this.#bodyElement ?? null;
  }

  /** The body's top in the scroller's content, whichever block the table is in. */
  public anchorTopPx(): number | undefined {
    this.#readUnreadBody();
    this.#rowStartPx = this.#viewport.rowStartPx(this.#rowKey) ?? this.#rowStartPx;
    return this.#rowStartPx + this.#bodyOffsetInRowPx;
  }

  /**
   * Hears each change that may move the body's tables. Where the body was laid out while no table
   * listened, it is observed anew, so its next report, before the next paint, tells this table too.
   */
  public subscribeToPlacement(listener: (change: TablePlacementChange) => void): Unsubscribe {
    const unsubscribe = this.#placementChanges.subscribe(listener);
    // A fresh observation reports the body's size in the next frame, before it paints; telling the
    // table here would redraw it from inside the effect that subscribes, where React defers it.
    if (this.#isUnread && this.#bodyElement !== undefined) {
      this.#observeBody(this.#bodyElement);
    }
    return unsubscribe;
  }

  /** Observes `element` for every change of its size, from its size now. */
  #observeBody(element: HTMLElement): void {
    this.#stopObservingBody?.();
    this.#stopObservingBody = observeElementResize(element, (entries) => {
      this.#noteBodyLaidOut(entries.at(-1));
    });
  }

  /**
   * Notes the body laid out anew; where a table listens, reads its type and place in its row at
   * once and tells its tables, and otherwise leaves both to be read when first asked.
   */
  #noteBodyLaidOut(entry: ResizeObserverEntry | undefined): void {
    this.#observedInlineSizePx = entry?.contentBoxSize[0]?.inlineSize ?? 0;
    this.#isUnread = true;
    if (this.#placementChanges.hasSinks) {
      this.#readUnreadBody();
      this.#placementChanges.emit("laid-out");
    }
  }

  /** Reads the body's type and place in its row, when it was laid out anew since they were read. */
  #readUnreadBody(): void {
    const element = this.#bodyElement;
    if (!this.#isUnread || element === undefined) {
      return;
    }
    this.#isUnread = false;
    const bodyType = readMarkdownBodyType(element, this.#observedInlineSizePx);
    if (!isSameBodyType(bodyType, this.#bodyType)) {
      this.#bodyType = bodyType;
    }
    this.#bodyOffsetInRowPx = offsetInRowPx(element);
  }
}
