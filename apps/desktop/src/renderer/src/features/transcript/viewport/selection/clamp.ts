// Where the browser's selection is written to show a recorded selection over the rows the window
// has drawn: each end where it sits while its row is drawn, where the reader put it outside the
// scroller, or else at the edge of the drawn rows the record covers, so the browser paints exactly
// the drawn part of the selection with its own selection.

import { resolveRowTextPosition, type RowTextPosition } from "./preservation.js";
import { otherSide, type RecordSide, type RowSelection, type SelectionPoint } from "./record.js";

/**
 * An end standing at the edge of the drawn rows: the drawn row, or the scroller when none is
 * drawn, the edge of it the end stands at, and where the browser's selection holds it.
 */
export interface ClampedEnd {
  readonly container: Element;
  readonly edge: RecordSide;
  readonly point: SelectionPoint;
}

/** Where one end of the record is written, and the edge it stands at while it is clamped. */
export interface ShownEnd {
  readonly point: SelectionPoint;
  readonly clamped: ClampedEnd | undefined;
}

/**
 * Where each end of the record is written: where it sits while its row is drawn, where the reader
 * put it outside the scroller, or else clamped to the edge of the drawn rows the record covers,
 * the first one's start or the last one's end, or the scroller's own edge when none is drawn.
 */
export function shownEndsOf(
  selection: RowSelection,
  rows: DrawnRows,
): Record<RecordSide, ShownEnd> {
  const startPosition = rows.logPositionOf(selection.start.rowKey);
  const endPosition = rows.logPositionOf(selection.end.rowKey);
  let firstCovered: { readonly position: number; readonly row: HTMLElement } | undefined;
  let lastCovered: { readonly position: number; readonly row: HTMLElement } | undefined;
  if (startPosition !== undefined && endPosition !== undefined) {
    for (const [rowKey, row] of rows.rowElementByKey) {
      const position = rows.logPositionOf(rowKey);
      if (position === undefined || position < startPosition || position > endPosition) {
        continue;
      }
      if (firstCovered === undefined || position < firstCovered.position) {
        firstCovered = { position, row };
      }
      if (lastCovered === undefined || position > lastCovered.position) {
        lastCovered = { position, row };
      }
    }
  }
  const shownEnd = (side: RecordSide): ShownEnd => {
    const outside = rows.outsidePoints[side];
    if (outside?.node.isConnected === true) {
      return { point: outside, clamped: undefined };
    }
    const boundary = selection[side];
    const row = rows.rowElementByKey.get(boundary.rowKey);
    const drawn =
      row === undefined
        ? undefined
        : boundary.position === undefined
          ? rowEdgePoint(row, side)
          : resolvedPoint(row, boundary.position);
    if (drawn !== undefined) {
      return { point: drawn, clamped: undefined };
    }
    const edgeRow = side === "start" ? firstCovered?.row : lastCovered?.row;
    // With no covered row drawn, the end stands past every drawn row on its side.
    const clamped: ClampedEnd =
      edgeRow === undefined
        ? {
            container: rows.scrollContainer,
            edge: otherSide(side),
            point: rowEdgePoint(rows.scrollContainer, otherSide(side)),
          }
        : { container: edgeRow, edge: side, point: rowEdgePoint(edgeRow, side) };
    return { point: clamped.point, clamped };
  };
  return { start: shownEnd("start"), end: shownEnd("end") };
}

/** The point before everything in `element`, or after everything. */
export function rowEdgePoint(element: Element, side: RecordSide): SelectionPoint {
  return { node: element, offset: side === "start" ? 0 : element.childNodes.length };
}

/** Whether `first` lies after `second` in the document. */
export function isAfter(first: SelectionPoint, second: SelectionPoint): boolean {
  const range = first.node.ownerDocument?.createRange();
  if (range === undefined) {
    return false;
  }
  range.setStart(second.node, second.offset);
  return range.comparePoint(first.node, first.offset) > 0;
}

/**
 * Whether `point` is the clamped end, or stands where it does with no text between: the browser
 * may hold an end it was given at an element's edge at the first or last character instead.
 */
export function standsAtClampedEnd(point: SelectionPoint, clamped: ClampedEnd): boolean {
  if (point.node === clamped.point.node && point.offset === clamped.point.offset) {
    return true;
  }
  const { container } = clamped;
  if (point.node !== container && !container.contains(point.node)) {
    return false;
  }
  const range = container.ownerDocument.createRange();
  range.selectNodeContents(container);
  if (clamped.edge === "start") {
    range.setEnd(point.node, point.offset);
  } else {
    range.setStart(point.node, point.offset);
  }
  return range.toString().trim() === "";
}

/** The drawn rows a recorded selection is written over, and the ends kept outside them. */
interface DrawnRows {
  readonly scrollContainer: HTMLElement;
  readonly rowElementByKey: ReadonlyMap<string, HTMLElement>;
  readonly logPositionOf: (rowKey: string) => number | undefined;
  readonly outsidePoints: Partial<Record<RecordSide, SelectionPoint>>;
}

/** The point a row text position names in a drawn row, or `undefined` when it is not drawn. */
function resolvedPoint(row: Element, position: RowTextPosition): SelectionPoint | undefined {
  const resolved = resolveRowTextPosition(row, position);
  return resolved === undefined
    ? undefined
    : { node: resolved.textNode, offset: resolved.offsetInNode };
}
