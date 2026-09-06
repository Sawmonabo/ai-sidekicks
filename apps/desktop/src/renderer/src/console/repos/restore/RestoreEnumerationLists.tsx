import { PathEnumeration } from "./PathEnumeration.js";
import { type RestoreEnumerations } from "./restore-enumerations.js";

/**
 * Both enumerations, always, in this surface's own density: counts on the face, lists
 * one click away, on `Spec-023 §Meridian, the design language` rule 7.
 *
 * They render even at zero — that is what "never silent" means on this surface — and
 * the empty pair carries the sentence that stops it reading as an all-clear.
 */
export function RestoreEnumerationLists(props: {
  readonly enumerations: RestoreEnumerations;
  readonly emptyCopy: string;
  readonly onOpenPath: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const { enumerations } = props;
  const isEmptyPair =
    enumerations.overwrittenIgnoredPaths.length === 0 &&
    enumerations.divergentGitlinks.length === 0;
  return (
    <div className="meridian-restore-disclosure__enumerations">
      <PathEnumeration
        label="Overwritten ignored paths"
        paths={enumerations.overwrittenIgnoredPaths}
        onOpenPath={props.onOpenPath}
      />
      <PathEnumeration
        label="Divergent gitlinks"
        paths={enumerations.divergentGitlinks}
        onOpenPath={props.onOpenPath}
      />
      {isEmptyPair ? (
        <p className="meridian-restore-disclosure__not-all-clear">{props.emptyCopy}</p>
      ) : null}
    </div>
  );
}
