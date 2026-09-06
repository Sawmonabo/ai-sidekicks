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
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  const artifacts = useMemo(() => foldProducedArtifacts(timeline), [timeline]);
  return <ProducedObjects artifacts={artifacts} cardsByArtifactId={props.cardsByArtifactId} />;
}
