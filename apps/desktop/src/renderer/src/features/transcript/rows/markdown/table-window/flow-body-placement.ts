// Where the tables of a markdown body drawn whole sit in the conversation scroller. The body has no
// window over its blocks, so a table measures its place from the body itself: the body's top is its
// row's start and its place in the row, read whenever the body is laid out anew, which also tells
// its tables to read their own place in it again.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { type MarkdownWindowViewport } from "../block-window/context.js";
import { isSameBodyType, readMarkdownBodyType, type MarkdownBodyType } from "../body-type.js";
import { type BlockParseSource } from "#renderer/components/Markdown/parse.js";
import {
  blockParseSourceOf,
  blockSourceStartOf,
  type MarkdownBodyBlocksSnapshot,
} from "../body-blocks.js";
import { offsetInRowPx } from "../scroller-window.js";
import { type TableBodyPlacement, type TablePlacementChange } from "./context.js";

/** The blocks a body drawn whole counts its tables' text in. */
export type FlowBodyBlocks = Pick<
  MarkdownBodyBlocksSnapshot,
  "settledBlocks" | "volatileTail" | "definitionPreamble" | "readBlockSource"
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
  /** The row's last known top, kept while the viewport lets the row go. */
  #rowStartPx = 0;

  /** The body's element, observed for every change of its size: a block above a table grew. */
  public readonly attachBody = (element: HTMLElement | null): void => {
    this.#stopObservingBody?.();
    this.#stopObservingBody = undefined;
    this.#bodyElement = element ?? undefined;
    if (element !== null) {
      this.#stopObservingBody = observeElementResize(element, (entries) => {
        this.#readBody(element, entries.at(-1));
      });
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

  public blockParseSource(index: number): () => BlockParseSource {
    return blockParseSourceOf(this.#blocks, index);
  }

  /** Every table here measures its place from the body. */
  public anchorOf(): Element | null {
    return this.#bodyElement ?? null;
  }

  /** The body's top in the scroller's content, whichever block the table is in. */
  public anchorTopPx(): number | undefined {
    this.#rowStartPx = this.#viewport.rowStartPx(this.#rowKey) ?? this.#rowStartPx;
    return this.#rowStartPx + this.#bodyOffsetInRowPx;
  }

  public subscribeToPlacement(listener: (change: TablePlacementChange) => void): Unsubscribe {
    return this.#placementChanges.subscribe(listener);
  }

  /** Reads the body's type and place in its row, and tells its tables it was laid out anew. */
  #readBody(element: HTMLElement, entry: ResizeObserverEntry | undefined): void {
    const bodyType = readMarkdownBodyType(element, entry?.contentBoxSize[0]?.inlineSize ?? 0);
    if (!isSameBodyType(bodyType, this.#bodyType)) {
      this.#bodyType = bodyType;
    }
    this.#bodyOffsetInRowPx = offsetInRowPx(element);
    this.#placementChanges.emit("laid-out");
  }
}
