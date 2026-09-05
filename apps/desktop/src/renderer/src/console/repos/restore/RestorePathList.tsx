import { RESTORE_PATH_VIRTUALIZATION_THRESHOLD } from "./restore-bounds.js";
import { WindowedRestorePathList } from "./WindowedRestorePathList.js";
import { RestorePathCell } from "./RestorePathCell.js";
import { type RestorePathListProps } from "./restore-path-window.js";

/**
 * The paths, windowed past the threshold and drawn in full below it.
 *
 * The branch is on the path COUNT and on nothing else — no measurement, no
 * capability probe — so which mode a given enumeration draws in is decidable from
 * the reading alone.
 */
export function RestorePathList(props: RestorePathListProps): React.JSX.Element {
  if (props.paths.length >= RESTORE_PATH_VIRTUALIZATION_THRESHOLD) {
    return <WindowedRestorePathList {...props} />;
  }
  return (
    <ul className="meridian-restore-disclosure__paths">
      {props.paths.map((path) => (
        <li key={path}>
          <RestorePathCell path={path} onOpenPath={props.onOpenPath} />
        </li>
      ))}
    </ul>
  );
}
