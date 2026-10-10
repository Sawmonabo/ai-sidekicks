// What a long table reads from the markdown body around it to window its rows against the
// conversation scroller: the viewport, and the body's answer for where the table's block sits. A
// windowed body answers from its own layout of its blocks, a body drawn whole from its own place in
// its row; the table reads both the same way.

import { createContext, type Context } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import { type MarkdownWindowViewport } from "../block-window/context.js";
import { type MarkdownBodyType } from "../body-type.js";
import { type TableFingerprints } from "./table-text.js";

/**
 * Why a body told its tables they may have moved: `"moved"`, a block above measured or the drawn
 * blocks changed; `"laid-out"`, the body was laid out anew, so a table's place in its anchor may
 * have changed too.
 */
export type TablePlacementChange = "moved" | "laid-out";

/** Where the tables of one markdown body sit in the conversation scroller, as the body answers. */
export interface TableBodyPlacement {
  /** The body's width and text size, or `undefined` before it is laid out. */
  readonly bodyType: MarkdownBodyType | undefined;
  /**
   * The document the body is drawn in, whose fonts its tables' cells set text in; `undefined`
   * before the body mounts.
   */
  readonly ownerDocument: Document | undefined;
  /** How long the definitions are that every parsed offset in the body counts. */
  readonly definitionPreambleLength: number;
  /** Where block `index` starts in the body's text, in UTF-16 code units. */
  blockSourceStart(index: number): number;
  /** The element a table measures its own place from: its block's wrapper, or the body. */
  anchorOf(element: Element): Element | null;
  /**
   * The top edge of the anchor of a table in block `blockIndex`, in the scroller's content, in CSS
   * pixels, reading no element; `undefined` while the body cannot place it.
   */
  anchorTopPx(blockIndex: number): number | undefined;
  /** Hears each change that may move the body's tables. */
  subscribeToPlacement(listener: (change: TablePlacementChange) => void): Unsubscribe;
}

/** The markdown body a long table is drawn in. */
export interface TableWindowBody {
  readonly viewport: MarkdownWindowViewport;
  readonly placement: TableBodyPlacement;
}

/** The body a table is drawn in, provided inside a transcript viewport; `undefined` outside one. */
export const TableWindowBodyContext: Context<TableWindowBody | undefined> = createContext<
  TableWindowBody | undefined
>(undefined);

/** The index of the body's block a table is drawn in, provided around each drawn block. */
export const MarkdownBlockIndexContext: Context<number | undefined> = createContext<
  number | undefined
>(undefined);

/** What a long table takes from the feed's listed bodies until its own body is laid out. */
export interface ListedBodies {
  /** The document the listed bodies are drawn in, whose fonts their tables set text in. */
  readonly ownerDocument: Document;
  /**
   * The type a listed reply's body takes at the rows' width now, as the frames off the list last
   * read it; `undefined` before one is read at that width.
   */
  readonly listedBodyType: () => MarkdownBodyType | undefined;
  /** The window's tables' fingerprints, read once for a table measured off the list and listed. */
  readonly tableFingerprints: TableFingerprints;
}

/**
 * The feed's listed bodies, provided around its viewport; `undefined` outside one. A table lays
 * out at their type until its own body is laid out, so a geometry measured off the list draws on
 * its first frame.
 */
export const ListedBodiesContext: Context<ListedBodies | undefined> = createContext<
  ListedBodies | undefined
>(undefined);
