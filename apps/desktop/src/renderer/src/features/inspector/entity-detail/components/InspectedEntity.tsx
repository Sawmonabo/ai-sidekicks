// The inspector's read: one entity, resolved and handed to its kind's record.
//
// Three subscriptions are held once for the whole pane: the addressed kind's partition (so a
// burst on another kind re-renders nothing), whether the first read has answered, and whether
// the projection is known-incomplete. Details receive them as props. The dispatch is a table
// read (`entity-detail-by-kind.ts`), typed to the kinds the inspector's address admits.

import {
  useSessionDegradedCause,
  useSessionInitialized,
} from "@renderer/store/session/hooks/useSessionInitialized.js";
import { useSessionPartition } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type EntityRef } from "@renderer/lib/entity-kinds.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { ENTITY_DETAIL_BY_KIND, type EntityDetailKind } from "../entity-detail-by-kind.js";

/** The addressed entity, the store it is read from, and the pane that linked to it. */
export interface InspectedEntityProps {
  /** What the pane layout addressed this pane with. */
  readonly entityRef: EntityRef & { readonly kind: EntityDetailKind };
  readonly sessionStore: SessionStore;
  /**
   * The pane this inspector was opened from, when the pane layout linked the two.
   *
   * A value passed in, not a handle held, so a link never costs a pane its independence.
   */
  readonly linkedSourcePaneId: string | undefined;
}

/** Resolve one entity from the session store and hand it to its kind's record. */
export function InspectedEntity(props: InspectedEntityProps): React.JSX.Element {
  const partition = useSessionPartition(props.sessionStore, props.entityRef.kind);
  const isInitialized = useSessionInitialized(props.sessionStore);
  const degradedCause = useSessionDegradedCause(props.sessionStore);
  const EntityDetail = ENTITY_DETAIL_BY_KIND[props.entityRef.kind];
  return (
    <EntityDetail
      entity={partition[props.entityRef.id]}
      entityId={props.entityRef.id}
      sessionStore={props.sessionStore}
      isInitialized={isInitialized}
      degradedCause={degradedCause}
      linkedSourcePaneId={props.linkedSourcePaneId}
    />
  );
}
