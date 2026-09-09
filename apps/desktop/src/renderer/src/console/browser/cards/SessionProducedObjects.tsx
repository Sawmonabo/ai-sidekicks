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
// in scope. `produced-provenance.ts` supplies the membership — which of the session's
// artifacts came out of the browser, as the daemon answers it, unioned with the ids
// this window's own capture acts minted — and the store supplies the state each of
// them has since reached. The fold takes the ids and reads the log; neither side alone
// is a shelf, and a fold that read only the log would list every artifact the session
// ever published as browser output.
//
// AND THE IDS ARRIVE HERE ALREADY JOINED, which is what keeps this component a fold
// over a set rather than a second place provenance is decided. It reads the KEYS of
// the map it is handed and asks nothing about how a key got there — so a key whose
// value is a card is drawn as one, a key whose value is the `named` arm is drawn as an
// identity row, and this file needs no branch for either.

import { useMemo } from "react";

import { useSessionStore, type SessionStore, type SessionStoreState } from "../../store/index.js";
import { foldProducedArtifacts, type ProducedObjectCard } from "./produced-objects.js";
import { ProducedObjects } from "./ProducedObjects.js";

export interface SessionProducedObjectsProps {
  readonly sessionStore: SessionStore;
  /**
   * Every produced object the shelf may list, keyed by artifact id.
   *
   * Its KEYS are the provenance and its values are what this window can say about
   * each — a card for an object it made, the `named` arm for one the daemon named.
   * `produced-provenance.ts` composes it.
   */
  readonly cardsByArtifactId: ReadonlyMap<string, ProducedObjectCard>;
}

export function SessionProducedObjects(props: SessionProducedObjectsProps): React.JSX.Element {
  const { cardsByArtifactId } = props;
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  // Derived from the joined map rather than rebuilt per render: that map's identity
  // moves only when the daemon's answer lands or this window produces something, so
  // the set and the fold below it both stand still while the overflow control
  // re-renders for every other reason it has to.
  const producedArtifactIds = useMemo(() => new Set(cardsByArtifactId.keys()), [cardsByArtifactId]);
  const artifacts = useMemo(
    () => foldProducedArtifacts(timeline, producedArtifactIds),
    [timeline, producedArtifactIds],
  );
  return <ProducedObjects artifacts={artifacts} cardsByArtifactId={cardsByArtifactId} />;
}

/** Declared once, so its identity never moves and the store never re-subscribes. */
function selectTimeline(state: SessionStoreState): SessionStoreState["timeline"] {
  return state.timeline;
}
