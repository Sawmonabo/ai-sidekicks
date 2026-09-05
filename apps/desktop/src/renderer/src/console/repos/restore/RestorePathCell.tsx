import { WireFigure } from "../../primitives/index.js";

/**
 * One path, as text or as the control that opens it.
 *
 * The link exists only where the mounting surface can honour it — a disclosure with
 * no diff behind it renders text rather than a dead control.
 *
 * THE TAB STOP IS THIS BUTTON AND NEVER THE ROW AROUND IT, on `DiffFileEntryButton`'s
 * rule: a row is a list item and this control is what opens the path, so a stop on the
 * `<li>` would answer Enter with nothing. The text arm takes no stop at all — there is
 * nothing to activate — and the list above says what it does instead.
 */
export function RestorePathCell(props: {
  readonly path: string;
  readonly onOpenPath: ((path: string) => void) | undefined;
  /** Whether this row holds the enumeration's one tab stop. Only the control can. */
  readonly isTabbable?: boolean;
}): React.JSX.Element {
  const { onOpenPath, path } = props;
  if (onOpenPath === undefined) {
    return <WireFigure value={path} />;
  }
  return (
    <button
      type="button"
      className="meridian-restore-disclosure__path-link"
      tabIndex={props.isTabbable === undefined ? undefined : props.isTabbable ? 0 : -1}
      onClick={() => {
        onOpenPath(path);
      }}
    >
      <WireFigure value={path} />
    </button>
  );
}
