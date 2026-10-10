// Where the tables of a markdown body drawn whole sit in the conversation scroller. The body has no
// window over its blocks, so a table measures its place from the body itself: the body's top is its
// row's start and its place in the row, read whenever the body is laid out anew, which also tells
// its tables to read their own place in it again. A body no table listens to reads nothing when it
// is laid out, only when asked, so a reply without a long table costs no layout read.

import type { Unsubscribe } from "#shared/preload-api.js";
import { type TranscriptBodyViewport } from "#renderer/components/TranscriptBodyViewport/context.js";
import { isSameBodyType, readMarkdownBodyType, type MarkdownBodyType } from "../body-type.js";
import { blockSourceStartOf, type MarkdownBodyBlocksSnapshot } from "../body-blocks.js";
import { offsetInRowPx } from "../scroller-window.js";
import { type TableBodyPlacement, type TablePlacementChange } from "./context.js";
import { warmIdeographFallback } from "./ideograph-fallback-warm.js";
import { TablePlacementReports } from "./placement-reports.js";

/** The blocks a body drawn whole counts its tables' text in. */
export type FlowBodyBlocks = Pick<
  MarkdownBodyBlocksSnapshot,
  "settledBlocks" | "volatileTail" | "definitionPreamble"
>;

/** The placement a body drawn whole gives its tables, observing the body's size. */
export class FlowBodyPlacement implements TableBodyPlacement {
  readonly #viewport: TranscriptBodyViewport;
  readonly #rowKey: string;
  readonly #reports = new TablePlacementReports("flow body placement change", (_element, entry) => {
    this.#noteBodyLaidOut(entry);
  });
  #blocks: FlowBodyBlocks;
  #bodyTextLength: number;
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
    if (element !== null) {
      warmIdeographFallback(element);
    }
    this.#reports.attach(element);
  };

  /** `viewport` and `rowKey` are held for the body's life. */
  public constructor(
    viewport: TranscriptBodyViewport,
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
    return this.#reports.element?.ownerDocument;
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
    return this.#reports.element ?? null;
  }

  /** The body's top in the scroller's content, whichever block the table is in. */
  public anchorTopPx(): number | undefined {
    this.#readUnreadBody();
    this.#rowStartPx = this.#viewport.rowStartPx(this.#rowKey) ?? this.#rowStartPx;
    return this.#rowStartPx + this.#bodyOffsetInRowPx;
  }

  public get layoutCount(): number {
    return this.#reports.layoutCount;
  }

  public subscribeToPlacement(
    listener: (change: TablePlacementChange) => void,
    seenLayoutCount: number,
  ): Unsubscribe {
    return this.#reports.subscribe(listener, seenLayoutCount);
  }

  /**
   * Notes the body laid out anew and tells its tables; where a table listens, reads its type and
   * place in its row first, and otherwise leaves both to be read when first asked.
   */
  #noteBodyLaidOut(entry: ResizeObserverEntry | undefined): void {
    this.#observedInlineSizePx = entry?.contentBoxSize[0]?.inlineSize ?? 0;
    this.#isUnread = true;
    if (this.#reports.hasListeners) {
      this.#readUnreadBody();
    }
    this.#reports.announce("laid-out");
  }

  /** Reads the body's type and place in its row, when it was laid out anew since they were read. */
  #readUnreadBody(): void {
    const element = this.#reports.element;
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
