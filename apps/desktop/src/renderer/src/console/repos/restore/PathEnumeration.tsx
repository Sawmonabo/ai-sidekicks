import { useState } from "react";
import { DerivedFigure, Nothing, formatCount } from "../../primitives/index.js";
import { RestorePathList } from "./RestorePathList.js";

/**
 * One enumeration: its count, then its paths.
 *
 * The count is always visible and the list is a `<details>` — this surface's density.
 *
 * THE CLOSED LIST HOLDS NO ROW, AND THAT IS STATE RATHER THAN MARKUP. A `<details>`
 * hides its children; it does not stop React from putting them in the document, so
 * the density note's whole point — a long enumeration costing one row until somebody
 * opens it — was being claimed by a comment and paid for by nobody. The open state is
 * therefore tracked and the list is rendered only while it is open.
 *
 * THE OPEN LIST WINDOWS PAST A THRESHOLD. `@tanstack/react-virtual` is a dependency of
 * this package and `RestorePathList.tsx` beside this file calls it directly. There is
 * no wrapper to reuse from the family's diff pane — that pane's virtualization is a
 * row index over a nested structure with a wrap-scoped measurement effect and its own
 * two-box layout, none of which a flat path list shares — so the adopted library is
 * the shared implementation and a generic wrapper over it would be a second
 * abstraction with two callers and no common behaviour.
 *
 * The residual is the sheet's inter-row gap, which the windowed mode drops because the
 * window arithmetic does not account for it. Nothing else differs between the two
 * modes, and below the threshold the list is drawn exactly as it always was.
 */
export function PathEnumeration(props: {
  readonly label: string;
  readonly paths: readonly string[];
  readonly onOpenPath: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  if (props.paths.length === 0) {
    return (
      <p className="meridian-restore-disclosure__count">
        {props.label} <DerivedFigure text={formatCount(0)} />{" "}
        <Nothing kind="empty" placement="inline" title="None enumerated." />
      </p>
    );
  }
  return (
    <details
      className="meridian-restore-disclosure__detail"
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
      }}
    >
      <summary className="meridian-restore-disclosure__detail-summary">
        {props.label} <DerivedFigure text={formatCount(props.paths.length)} />
      </summary>
      {isOpen ? (
        <RestorePathList label={props.label} paths={props.paths} onOpenPath={props.onOpenPath} />
      ) : null}
    </details>
  );
}
