import { WireFigure, type WindowedRowTargetProps } from "../../primitives/index.js";

/** One path, and the row's own statement about where its tab stop went. */
export type RestorePathCellProps = {
  readonly path: string;
  readonly onOpenPath: ((path: string) => void) | undefined;
  /**
   * The roving stop and the target marker, where the row delegated them.
   *
   * ABSENT ON THE TEXT ARM'S LIST AND ON THE UNWINDOWED ONE, which is why it is
   * optional: a list whose rows carry no control is not a composite widget, its scroll
   * region keeps the one stop it always had, and there is nothing here to mark.
   */
  readonly targetProps?: WindowedRowTargetProps;
};

/**
 * One path, as text or as the control that opens it.
 *
 * The link exists only where the mounting surface can honour it — a disclosure with
 * no diff behind it renders text rather than a dead control.
 *
 * THE TAB STOP IS THIS BUTTON AND NEVER THE ROW AROUND IT, on `DiffFileEntryButton`'s
 * rule: a row is a list item and this control is what opens the path, so a stop on the
 * `<li>` would answer Enter with nothing. The row DELEGATES both the index and the
 * marker rather than the cell computing one from a flag — without which the row marked
 * itself as the focus target and the roving effect called `focus()` on an `<li>` that
 * has no `tabindex`, which Chromium ignores. The text arm takes no stop at all —
 * there is nothing to activate — and the list above says what it does instead.
 */
export function RestorePathCell(props: RestorePathCellProps): React.JSX.Element {
  const { onOpenPath, path } = props;
  if (onOpenPath === undefined) {
    return <WireFigure value={path} />;
  }
  return (
    <button
      type="button"
      className="meridian-restore-disclosure__path-link"
      {...props.targetProps}
      onClick={() => {
        onOpenPath(path);
      }}
    >
      <WireFigure value={path} />
    </button>
  );
}
