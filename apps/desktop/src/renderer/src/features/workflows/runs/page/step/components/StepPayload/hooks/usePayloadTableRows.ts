import { useCallback, useMemo, useState } from "react";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/document";

import { parseMarkdownDocument } from "../markdown-document-rows.js";
import { useCodeSpanReader } from "#renderer/services/highlight/hooks/useCodeSpanReader.js";
import { PayloadTableRows, type PayloadTableRow } from "../rows.js";

/** A payload's Table view rows, and the call a drawn row makes to have its string read. */
export interface PayloadTableRowsBinding {
  readonly rows: readonly PayloadTableRow[];
  readonly readString: (stringIndex: number) => void;
  /** A key that stays with its row as reads before it add rows. */
  readonly rowKey: (rowIndex: number) => number;
}

/**
 * A payload's Table view rows, one model per payload. A string is parsed only once its row is
 * drawn, so a large payload parses what the reader reaches; its markdown is colored by the window.
 */
export function usePayloadTableRows(items: readonly WorkflowItem[]): PayloadTableRowsBinding {
  const codeSpanReader = useCodeSpanReader();
  const model = useMemo(
    () => new PayloadTableRows(items, (text) => parseMarkdownDocument(text, codeSpanReader)),
    [items, codeSpanReader],
  );
  // The model's rows change as strings are read; each read that changed them draws again.
  const [, setReadCount] = useState(0);
  const readString = useCallback(
    (stringIndex: number) => {
      if (model.readString(stringIndex)) {
        setReadCount((count) => count + 1);
      }
    },
    [model],
  );
  const rowKey = useCallback((rowIndex: number) => model.rowKey(rowIndex), [model]);
  return { rows: model.rows, readString, rowKey };
}
