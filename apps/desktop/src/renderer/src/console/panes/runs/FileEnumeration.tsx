// One never-silent file list inside a rollback disclosure.
//
// Split from `RollbackDisclosure.tsx`, which decides WHICH enumerations a settled
// rollback owes a reader, while this renders one of them.
//
// NEVER SILENT MEANS NEVER EMPTY-BY-OMISSION. A list with no paths still renders
// its label and says so, because a restore that touched nothing and a restore whose
// report was dropped look identical once the section is hidden.

import { DerivedFigure, WireFigure } from "../../primitives/index.js";
import { formatCount } from "../../primitives/index.js";

/**
 * One never-silent enumeration, collapsed behind its own count.
 *
 * The paths are wire strings and render verbatim — a truncated path is a wrong
 * path, and `Spec-023 §Rules every console surface obeys` puts "roots and paths"
 * among the byte-for-byte strings that "render exactly as received".
 */
export function FileEnumeration(props: {
  readonly label: string;
  readonly paths: readonly string[];
}): React.JSX.Element {
  return (
    <details className="meridian-rollback__enumeration">
      <summary className="meridian-rollback__enumeration-summary">
        {props.label}
        <DerivedFigure text={formatCount(props.paths.length)} />
      </summary>
      {props.paths.length === 0 ? (
        <p className="meridian-rollback__enumeration-empty">
          None. The daemon reported an empty list, which is different from not having looked.
        </p>
      ) : (
        <ul className="meridian-rollback__enumeration-list">
          {props.paths.map((path) => (
            <li key={path}>
              <WireFigure value={path} />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
