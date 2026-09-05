// The inspector's read: one entity, resolved and handed to its kind's record.
//
// Three subscriptions, held once for the whole pane and none of them per facet:
// the addressed kind's partition (whose identity changes only when that kind
// changes, so a burst on another kind re-renders nothing here), whether the store's
// first read has answered, and whether the projection is known-incomplete. The
// twelve details receive the answers as props and subscribe to nothing themselves
// unless they COMPOSE — which two of them do, over partitions of their own.
//
// The dispatch is a table read and not a switch: `entity-detail-registry.ts` is
// total over the entity kinds by type, so there is no arm here for a kind nobody
// wrote a record for, and no fallback that would render one as a blank pane.

import {
  useSessionDegradedCause,
  useSessionInitialised,
  useSessionPartition,
  type ConsoleEntityRef,
  type SessionStore,
} from "../../../store/index.js";
import { ENTITY_DETAIL_BY_KIND } from "./entity-detail-registry.js";

export interface InspectedEntityProps {
  /** What the deck addressed this pane with. */
  readonly entityRef: ConsoleEntityRef;
  readonly sessionStore: SessionStore;
  /**
   * The pane this inspector was opened from, when the deck linked the two.
   *
   * A prop rather than a lookup. `Spec-023 §Meridian, the design language`'s layout
   * grammar makes the inspector "a pane kind, not a fixed third column", and this
   * console's own rule is that a link to a source pane never costs a pane its
   * independence — so the link is a value passed in and never a handle held.
   */
  readonly linkedSourcePaneId: string | undefined;
}

export function InspectedEntity(props: InspectedEntityProps): React.JSX.Element {
  const partition = useSessionPartition(props.sessionStore, props.entityRef.kind);
  const isInitialised = useSessionInitialised(props.sessionStore);
  const degradedCause = useSessionDegradedCause(props.sessionStore);
  const EntityDetail = ENTITY_DETAIL_BY_KIND[props.entityRef.kind];
  return (
    <EntityDetail
      entity={partition[props.entityRef.id]}
      entityId={props.entityRef.id}
      sessionStore={props.sessionStore}
      isInitialised={isInitialised}
      degradedCause={degradedCause}
      linkedSourcePaneId={props.linkedSourcePaneId}
    />
  );
}
