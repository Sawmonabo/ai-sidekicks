import { WireFigure } from "../../primitives/index.js";

/**
 * One path, as text or as the control that opens it.
 *
 * The link exists only where the mounting surface can honour it — a disclosure with
 * no diff behind it renders text rather than a dead control.
 */
export function RestorePathCell(props: {
  readonly path: string;
  readonly onOpenPath: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const { onOpenPath, path } = props;
  if (onOpenPath === undefined) {
    return <WireFigure value={path} />;
  }
  return (
    <button
      type="button"
      className="meridian-restore-disclosure__path-link"
      onClick={() => {
        onOpenPath(path);
      }}
    >
      <WireFigure value={path} />
    </button>
  );
}
