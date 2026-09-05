// One row of a windowed list, saying where it sits in the whole enumeration.
//
// A WINDOW MOUNTS A SLICE, and the accessibility tree cannot tell a slice from a
// list. Without `aria-setsize` and `aria-posinset` a screen reader is told the list
// is as long as the window: "item 3 of 12" for row 3 of a 4,000-row enumeration,
// which is not a smaller reading of the truth but a different and false one. Both
// members are therefore written here, together, for every windowed row in the
// console — the repos family's restore list carried them and its own diff file list
// did not, which is exactly what happens when the pair is a call site's to remember.
//
// PLACEMENT IS THE CALLER'S AND IS NOT SHARED. The two lists that window today place
// their rows differently — one stacks them contiguously behind a single translated
// list, the other translates each row to its own offset — and each is right for its
// own sheet. So this component takes `className` and `style` and imposes neither, and
// there is no list-level wrapper above it: read together, the two consumers share the
// ROW and nothing else, and a wrapper over one shared member would be an abstraction
// with two callers and no behaviour in common.
//
// THE ELEMENT IS THE CALLER'S TOO, and it matters. A `<li>` inside a real `<ul>` is a
// list item in the accessibility tree even when it is absolutely placed; a `<div>`
// between a `<ul>` and its items is not. A list whose semantics are the element's
// passes `"li"`; a grid whose semantics are its roles passes `"div"` and the role.
//
// FAIL-CLOSED ON AN INDEX THAT IS NOT A POSITION, ON EVERY MEMBER THAT CARRIES ONE.
// A row index outside the enumeration cannot be clamped into a neighbour's position
// — that would attribute the row to a place in the list it does not hold, which is
// the same error as clamping a participant hue into someone else's colour. The row
// instead declares the set size UNKNOWN, which `aria-setsize="-1"` means exactly,
// and claims no position at all. A reader is told less rather than told something
// false.
//
// The index ATTRIBUTE is one of those members and not an exemption from the rule.
// It is what the roving keyboard resolves a move against, and it is resolved with
// `querySelector`, which takes the first match — so two rows written with the same
// out-of-range index are one row as far as the keyboard is concerned. A row that
// withheld its position from a screen reader and still offered it to the keyboard
// would be fail-closed in the tree and fail-open in the one place a person moves
// through the list, so the attribute is omitted on exactly the same predicate. A row
// with no position is a row the keyboard cannot land on, which the effect that reads
// it already handles.

import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "./windowed-row-index.js";

/** What ARIA's "the size of this set is not known" is spelled as. */
const UNKNOWN_SET_SIZE = -1;

export interface WindowedListRowProps {
  /** The element the row is, so the caller's list semantics survive the window. */
  readonly as: "li" | "div";
  /** This row's position in the WHOLE enumeration, counted from zero. */
  readonly rowIndex: number;
  /** The whole enumeration's length — never the mounted window's. */
  readonly totalRowCount: number;
  /** An explicit role, for a list whose semantics are not its element's. */
  readonly role?: "row" | "option";
  readonly className?: string;
  /** Where the caller's window places this row. Imposed here for nothing else. */
  readonly style?: React.CSSProperties;
  /**
   * Whether this row holds the list's one tab stop.
   *
   * Omitted where the list is not a composite widget — a scroll region that is one
   * focus stop of its own has no roving row.
   */
  readonly isTabbable?: boolean;
  /** The virtualizer's measurement callback, where the caller measures rows. */
  readonly rowRef?: (element: HTMLElement | null) => void;
  readonly children?: React.ReactNode;
}

export function WindowedListRow(props: WindowedListRowProps): React.JSX.Element {
  const isPosition =
    Number.isInteger(props.rowIndex) && props.rowIndex >= 0 && props.rowIndex < props.totalRowCount;

  // Assembled once and spread, because the three members are one claim: a row that
  // carried a set size and no position, or an index attribute and neither, would be
  // a half-made statement about where it sits, and the ARIA pair is what the
  // console's own gate reads.
  const rowProps = {
    className: props.className,
    style: props.style,
    role: props.role,
    tabIndex: props.isTabbable === undefined ? undefined : props.isTabbable ? 0 : -1,
    [WINDOWED_ROW_INDEX_ATTRIBUTE]: isPosition ? props.rowIndex : undefined,
    "aria-setsize": isPosition ? props.totalRowCount : UNKNOWN_SET_SIZE,
    "aria-posinset": isPosition ? props.rowIndex + 1 : undefined,
  };

  if (props.as === "li") {
    return (
      <li {...rowProps} ref={props.rowRef}>
        {props.children}
      </li>
    );
  }
  return (
    <div {...rowProps} ref={props.rowRef}>
      {props.children}
    </div>
  );
}
