// The inspector's read: one entity, resolved and handed to its kind's record.
//
// Three subscriptions, held once for the whole pane and none of them per facet:
// the addressed kind's partition (whose identity changes only when that kind
// changes, so a burst on another kind re-renders nothing here), whether the store's
// first read has answered, and whether the projection is known-incomplete. The
// details receive the answers as props and subscribe to nothing themselves.
//
// The dispatch is a table read and not a switch: `entity-detail-by-kind.ts` lists the
// kinds the inspector's address admits, and the address this reads is typed to those alone.

import {
  useSessionDegradedCause,
  useSessionInitialized,
} from "@renderer/store/session/hooks/useSessionInitialized.js";
import { useSessionPartition } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type EntityRef } from "@renderer/lib/entity-kinds.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { ENTITY_DETAIL_BY_KIND, type EntityDetailKind } from "../entity-detail-by-kind.js";

export interface InspectedEntityProps {
  /** What the deck addressed this pane with. */
  readonly entityRef: EntityRef & { readonly kind: EntityDetailKind };
  readonly sessionStore: SessionStore;
  /**
   * The pane this inspector was opened from, when the deck linked the two.
   *
   * A prop rather than a lookup. The inspector is a pane kind and not a fixed third
   * column, and this console's own rule is that a link to a source pane never costs
   * a pane its independence — so the link is a value passed in and never a handle
   * held.
   */
  readonly linkedSourcePaneId: string | undefined;
}

export function InspectedEntity(props: InspectedEntityProps): React.JSX.Element {
  const partition = useSessionPartition(props.sessionStore, props.entityRef.kind);
  const isInitialised = useSessionInitialized(props.sessionStore);
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
