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
// THE ROLE IS A CLOSED SET, AND WHAT CLOSES IT IS THE PAIR. A role belongs here only
// where `aria-posinset` and `aria-setsize` are defined on it, because those two
// members are the whole of what this component writes: on a role that does not take
// them the primitive would be rendering a claim the accessibility tree drops, which
// is the silent half of the very failure it exists to prevent. `row` and `option`
// take them as a grid row and a listbox option; `article` takes them as an article
// inside a `feed`, which is the pattern a chronological stream of long entries is
// (WAI-ARIA Authoring Practices, "Feed Pattern": a feed's articles carry
// `aria-posinset` and `aria-setsize` so a reader knows where in the stream it is).
// A role outside the set is a compile error rather than a silently dropped pair.
//
// FAIL-CLOSED ON AN INDEX THAT IS NOT A POSITION, ON EVERY MEMBER THAT CARRIES ONE.
// A row index outside the enumeration cannot be clamped into a neighbour's position
// — that would attribute the row to a place in the list it does not hold, which is
// the same error as clamping a participant hue into someone else's colour. The row
// instead declares the set size UNKNOWN, which `aria-setsize="-1"` means exactly,
// and claims no position at all. A reader is told less rather than told something
// false.
//
// ONE TAB STOP PER ROW, AND THE ROW SAYS WHICH ELEMENT HOLDS IT. The WAI-ARIA
// Authoring Practices Guide's roving-tabindex rule ("Developing a Keyboard Interface /
// Managing Focus Within Components Using a Roving tabindex") is that the element in
// the tab sequence carries `tabindex="0"` and every other focusable element in the
// composite carries `tabindex="-1"`. This component used to put the roving index on
// the wrapper and leave its children alone, which broke both halves at once: a row
// whose content is a button — the shape every windowed list the console has drafted
// takes — kept that button's native tab stop, so every mounted row was back in the
// page's tab order, the active row had two stops, and the roving effect's focus
// selector matched the wrapper before it ever reached the control.
//
// So a row DELEGATES its stop, and the delegation is a value rather than a
// convention. Children passed as a node are content and the row holds the stop
// itself; children passed as a FUNCTION are handed the roving `tabIndex` and the
// target marker to spread onto the one control they render, and the row then writes
// neither on itself. Exactly one element per row carries the pair, which is what makes
// "one tab stop" a property of this component instead of a caller's discipline.
//
// DELEGATION RATHER THAN A ROW-LEVEL STOP, and the reason is the console's rows. The
// other reading of the APG rule — the row is the stop, its controls are all
// `tabindex="-1"`, and Enter on the row reaches them — is right for a grid whose cells
// hold widgets. Every windowed list in this console is a list of CONTROLS: the repos
// family's diff file list is a `<li>` around a button, which is the corpus the
// windowed-row gate's own negative control is drawn from. Taking the stop off those
// buttons would take activation off them too, and the row would have to invent a
// second activation path beside the one the button already has, on an element with no
// role and no accessible name. Delegation keeps Enter, Space, and click where the
// platform already put them.
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

import {
  WINDOWED_ROW_INDEX_ATTRIBUTE,
  WINDOWED_ROW_TARGET_ATTRIBUTE,
} from "./windowed-row-markers.js";

/** What ARIA's "the size of this set is not known" is spelled as. */
const UNKNOWN_SET_SIZE = -1;

/**
 * What the row hands the one control it delegates its tab stop to.
 *
 * Spread onto that control and onto nothing else. The marker is written as a mapped
 * key rather than as a literal so the attribute name has one home — the reader
 * declares it, this hands it out, and neither can drift from the other.
 */
export type WindowedRowTargetProps = {
  /**
   * `0` on the list's one active row, `-1` on every other, and absent where the list
   * is not a composite widget and its controls keep their native stops.
   */
  readonly tabIndex: number | undefined;
} & { readonly [Key in typeof WINDOWED_ROW_TARGET_ATTRIBUTE]: "" };

export interface WindowedListRowProps {
  /** The element the row is, so the caller's list semantics survive the window. */
  readonly as: "li" | "div";
  /** This row's position in the WHOLE enumeration, counted from zero. */
  readonly rowIndex: number;
  /** The whole enumeration's length — never the mounted window's. */
  readonly totalRowCount: number;
  /**
   * An explicit role, for a list whose semantics are not its element's.
   *
   * Closed at the three roles `aria-posinset` and `aria-setsize` are defined on — a
   * grid row, a listbox option, and an article inside a `feed`. See this module's
   * header on why a role that does not take the pair does not belong in the set.
   */
  readonly role?: "row" | "option" | "article";
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
  /**
   * The row's content, and where its tab stop goes.
   *
   * A node is content and the row holds the stop itself — the listbox shape, where
   * the row is the option. A FUNCTION is a row whose content is a control: it is
   * handed the roving props and spreads them onto that one control, and the row then
   * carries no tab stop of its own. See this module's header on why a row of controls
   * delegates rather than keeping the stop and pushing its descendants to `-1`.
   */
  readonly children?: React.ReactNode | ((targetProps: WindowedRowTargetProps) => React.ReactNode);
}

export function WindowedListRow(props: WindowedListRowProps): React.JSX.Element {
  const isPosition =
    Number.isInteger(props.rowIndex) && props.rowIndex >= 0 && props.rowIndex < props.totalRowCount;

  const { children } = props;
  const delegatesTheTabStop = typeof children === "function";
  const rowTabIndex = props.isTabbable === undefined ? undefined : props.isTabbable ? 0 : -1;

  // Assembled once and spread, because the members are one claim: a row that carried
  // a set size and no position, or an index attribute and neither, would be a
  // half-made statement about where it sits, and the ARIA pair is what the console's
  // own gate reads. The tab index and the target marker travel together for the same
  // reason — the marked element IS the tab stop, and a row that wrote one without the
  // other would leave the roving effect focusing something that cannot take focus.
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
