// One row of a windowed list, saying where it sits in the whole enumeration.
//
// A window mounts a slice, and without `aria-setsize` and `aria-posinset` a screen reader is told
// the list is as long as the window ("item 3 of 12" for row 3 of 4,000). Both are written here,
// together, for every windowed row.
//
// Placement (`className`, `style`) and the element (`li` inside a real `ul`, or `div` with a
// role) belong to the caller; the consumers share the row and nothing else.
//
// The role is limited to `row`, `option` and `article` (in a `feed`), the roles that define the
// pair; any other role is a compile error, not a silently dropped pair.
//
// Fail closed: a row index outside the enumeration is not clamped into a neighbor's position.
// The row declares `aria-setsize="-1"` (unknown) and claims no position, and it omits the index
// attribute on the same predicate, because the roving keyboard resolves a move with
// `querySelector` and two rows with one out-of-range index would be one row to it.
//
// One tab stop per row. Node children are content and the row holds the stop itself; function
// children are handed the roving `tabIndex` and target marker to spread onto the one control they
// render, and the row then writes neither. Delegation keeps Enter, Space and click on the button
// of a row of controls, where a row-level stop would need a second activation path.

import {
  WINDOWED_ROW_INDEX_ATTRIBUTE,
  WINDOWED_ROW_TARGET_ATTRIBUTE,
} from "@renderer/lib/windowed-row-markers.js";

/** What ARIA's "the size of this set is not known" is spelled as. */
const UNKNOWN_SET_SIZE = -1;

/**
 * What the row hands the one control it delegates its tab stop to; spread onto that control only.
 * The marker key comes from the reader's declaration, so the attribute name has one home.
 */
export type WindowedRowTargetProps = {
  /**
   * `0` on the list's one active row, `-1` on every other, and absent where the list is not a
   * composite.
   */
  readonly tabIndex: number | undefined;
} & { readonly [Key in typeof WINDOWED_ROW_TARGET_ATTRIBUTE]: "" };

/** Props for `WindowedListRow`. */
export interface WindowedListRowProps {
  /** The element the row is, so the caller's list semantics survive the window. */
  readonly as: "li" | "div";
  /** This row's position in the WHOLE enumeration, counted from zero. */
  readonly rowIndex: number;
  /** The whole enumeration's length — never the mounted window's. */
  readonly totalRowCount: number;
  /**
   * An explicit role for a list whose semantics are not its element's; closed at the roles that
   * take the pair.
   */
  readonly role?: "row" | "option" | "article";
  readonly className?: string;
  /** Where the caller's window places this row. Imposed here for nothing else. */
  readonly style?: React.CSSProperties;
  /**
   * Whether this row holds the list's one tab stop; omitted where the list is not a composite
   * widget.
   */
  readonly isTabbable?: boolean;
  /** The virtualizer's measurement callback, where the caller measures rows. */
  readonly rowRef?: (element: HTMLElement | null) => void;
  /**
   * The row's content. A node is content and the row holds the tab stop (the listbox shape); a
   * function receives the roving props to spread onto the one control it renders.
   */
  readonly children?: React.ReactNode | ((targetProps: WindowedRowTargetProps) => React.ReactNode);
}

/**
 * A row that writes its enumeration position, with the tab stop on itself or on its one control.
 */
export function WindowedListRow(props: WindowedListRowProps): React.JSX.Element {
  const isPosition =
    Number.isInteger(props.rowIndex) && props.rowIndex >= 0 && props.rowIndex < props.totalRowCount;

  const { children } = props;
  const delegatesTheTabStop = typeof children === "function";
  const rowTabIndex = props.isTabbable === undefined ? undefined : props.isTabbable ? 0 : -1;

  // Spread together, since the members are one claim about position; the tab index and the
  // target marker also travel together, as the marked element is the tab stop.
  const rowProps = {
    className: props.className,
    style: props.style,
    role: props.role,
    tabIndex: delegatesTheTabStop ? undefined : rowTabIndex,
    [WINDOWED_ROW_TARGET_ATTRIBUTE]: delegatesTheTabStop ? undefined : "",
    [WINDOWED_ROW_INDEX_ATTRIBUTE]: isPosition ? props.rowIndex : undefined,
    "aria-setsize": isPosition ? props.totalRowCount : UNKNOWN_SET_SIZE,
    "aria-posinset": isPosition ? props.rowIndex + 1 : undefined,
  };

  const body = delegatesTheTabStop
    ? children({ tabIndex: rowTabIndex, [WINDOWED_ROW_TARGET_ATTRIBUTE]: "" })
    : children;

  if (props.as === "li") {
    return (
      <li {...rowProps} ref={props.rowRef}>
        {body}
      </li>
    );
  }
  return (
    <div {...rowProps} ref={props.rowRef}>
      {body}
    </div>
  );
}
