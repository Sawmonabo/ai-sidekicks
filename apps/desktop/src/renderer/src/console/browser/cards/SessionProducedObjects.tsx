// The produced-object shelf, bound to the session whose log it folds.
//
// A component of its own for `terminal/pane/BoundTerminalPane.tsx`'s reason, stated
// there and true here: the store hook below may only be called when there IS a store,
// and a hook behind a condition is the one React rule a surface cannot bend. The
// condition becomes a MOUNT rather than a branch inside one render, and the pane above
// renders the honest absence for a deck pane that sits in no session.
//
// THE FOLD IS MEMOISED ON THE TIMELINE, and the selector is declared at module level,
// so the store publishes a new array only when the log actually moves and the
// reduction runs once per move rather than once per render of the overflow control.
//
// THIS IS ALSO WHERE THE JOIN HAPPENS, because this is the one place both halves are
// in scope. The pane's register supplies the provenance — the ids this window's own
// capture and download acts answered with, which is the only record anywhere that an
// artifact came from the browser — and the store supplies the state each of them has
// since reached. The fold takes the ids and reads the log; neither side alone is a
// shelf, and a fold that read only the log would list every artifact the session ever
// published as browser output.

import { useMemo } from "react";

import { useSessionStore, type SessionStore, type SessionStoreState } from "../../store/index.js";
import { foldProducedArtifacts, type ProducedObjectCard } from "./produced-objects.js";
import { ProducedObjects } from "./ProducedObjects.js";

/** Declared once, so its identity never moves and the store never re-subscribes. */
function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}

export interface SessionProducedObjectsProps {
  readonly sessionStore: SessionStore;
  /** Cards for the objects this window itself produced, keyed by artifact id. */
  readonly cardsByArtifactId: ReadonlyMap<string, ProducedObjectCard>;
}

export function SessionProducedObjects(props: SessionProducedObjectsProps): React.JSX.Element {
  const { cardsByArtifactId } = props;
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  // Held on the register rather than rebuilt per render: the map's identity moves only
  // when this window produces something, so the set and the fold below it both stand
  // still while the overflow control re-renders for every other reason it has to.
  const producedArtifactIds = useMemo(() => new Set(cardsByArtifactId.keys()), [cardsByArtifactId]);
  const artifacts = useMemo(
    () => foldProducedArtifacts(timeline, producedArtifactIds),
    [timeline, producedArtifactIds],
  );
  return <ProducedObjects artifacts={artifacts} cardsByArtifactId={cardsByArtifactId} />;
}
