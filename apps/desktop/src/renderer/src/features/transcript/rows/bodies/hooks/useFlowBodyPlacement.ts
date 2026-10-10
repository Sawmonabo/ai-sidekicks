import { useMemo, useState } from "react";

import { type MarkdownWindowViewport } from "../../markdown/block-window/context.js";
import { type TableWindowBody } from "../../markdown/table-window/context.js";
import {
  FlowBodyPlacement,
  type FlowBodyBlocks,
} from "../../markdown/table-window/flow-body-placement.js";

/** What a body drawn whole gives the long tables in it. */
export interface FlowTableBody {
  /** The body and its placement, the same object for the body's life. */
  readonly tableBody: TableWindowBody;
  /** The body's element, whose size and place in its row the placement reads. */
  readonly attachBody: (element: HTMLElement | null) => void;
}

/**
 * The placement a body drawn whole in a transcript viewport gives its long tables; `undefined`
 * outside a viewport, where every table is drawn whole. `viewport` and `rowKey` are held for the
 * body's life.
 */
export function useFlowBodyPlacement(
  viewport: MarkdownWindowViewport | undefined,
  rowKey: string,
  blocks: FlowBodyBlocks,
  bodyTextLength: number,
): FlowTableBody | undefined {
  const [placement] = useState(() =>
    viewport === undefined
      ? undefined
      : new FlowBodyPlacement(viewport, rowKey, blocks, bodyTextLength),
  );
  placement?.setBlocks(blocks, bodyTextLength);
  const tableBody = useMemo(
    () => (viewport === undefined || placement === undefined ? undefined : { viewport, placement }),
    [viewport, placement],
  );
  return placement === undefined || tableBody === undefined
    ? undefined
    : { tableBody, attachBody: placement.attachBody };
}
