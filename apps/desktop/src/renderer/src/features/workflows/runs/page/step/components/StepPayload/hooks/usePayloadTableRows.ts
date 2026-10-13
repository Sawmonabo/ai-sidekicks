import { useCallback, useContext, useMemo, useState } from "react";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/document";

import { BlockCopyRendererContext } from "#renderer/components/Markdown/block-copy-offer.js";
import { byteOrderMarkLengthOf } from "#renderer/components/Markdown/parse/byte-order-mark.js";
import { appMarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { useCodeSpanReader } from "#renderer/services/highlight/hooks/useCodeSpanReader.js";
import { markdownDocumentOf } from "../markdown-document-rows.js";
import {
  PAYLOAD_ROW_ESTIMATE_PX,
  PAYLOAD_VIEWPORT_FALLBACK_HEIGHT_PX,
} from "../PayloadRowWindow.js";
import { PayloadTableRows, type PayloadTableRow } from "../rows.js";

/** A payload's Table view rows, the room its waiting rows keep, and the call that reads further. */
export interface PayloadTableRowsBinding {
  readonly rows: readonly PayloadTableRow[];
  /** The room below the rows that the rows not yet drawn keep, in CSS pixels. */
  readonly waitingHeightPx: number;
  /**
   * Read the strings a window's height past the list's end, and `reachedPx` further: how far into
   * the waiting rows' room the view reaches.
   */
  readonly readAhead: (reachedPx?: number) => void;
}

/**
 * A payload's Table view rows, one model per payload. Strings are parsed in order as the list's
 * last drawn row comes into the window, so a large payload parses what the reader reaches; its
 * markdown is colored by the window. A string whose parse failed throws, for the screen's error
 * boundary.
 */
export function usePayloadTableRows(items: readonly WorkflowItem[]): PayloadTableRowsBinding {
  const codeSpanReader = useCodeSpanReader();
  const renderCopy = useContext(BlockCopyRendererContext);
  const model = useMemo(
    () =>
      new PayloadTableRows(items, (text, settle) => {
        // A string's own markdown starts past the byte order mark it opens on.
        const markdown = text.slice(byteOrderMarkLengthOf(text));
        appMarkdownTrees.requestSettledBlock(markdown, "", (outcome) => {
          settle(
            outcome.status === "parsed"
              ? {
                  status: "read",
                  document: markdownDocumentOf(outcome.root, codeSpanReader, renderCopy),
                }
              : outcome,
          );
        });
      }),
    [items, codeSpanReader, renderCopy],
  );
  // The model's rows grow as strings are read; each read that lands draws again. A read ahead
  // covers as many one-line rows as the window shows before it is measured, so the worker's one
  // round trip fills the view rather than one row of it.
  const [, setReadCount] = useState(0);
  const readAhead = useCallback(
    (reachedPx = 0) => {
      model.readAhead(
        Math.ceil((PAYLOAD_VIEWPORT_FALLBACK_HEIGHT_PX + reachedPx) / PAYLOAD_ROW_ESTIMATE_PX),
        () => {
          setReadCount((count) => count + 1);
        },
      );
    },
    [model],
  );
  if (model.failure !== undefined) {
    throw new Error(model.failure);
  }
  return {
    rows: model.rows,
    waitingHeightPx: model.waitingLineCount * PAYLOAD_ROW_ESTIMATE_PX,
    readAhead,
  };
}
