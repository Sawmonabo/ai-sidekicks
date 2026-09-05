// The session's own record: the one entity whose facts are all composed.
//
// Every other kind reads a projected row. A session has no row — the STORE is the
// session, opened by the registry and keyed by the id the deck addressed — so this
// detail's facets are counts over the partitions the store holds, and its record
// exists exactly when the store's id is the one being inspected.
//
// It composes rather than denormalises, which is the store family's own rule: a
// count held on a session row would be a second source of truth that the reconnect
// path could not heal, so the count is taken at read time from the partition that
// owns it.

import { useSessionPartition } from "../../../store/index.js";
import { EntityRecord } from "./EntityRecord.js";
import { composedCountFacet, instantFacet, type EntityDetailProps } from "./entity-facets.js";

export function SessionEntityDetail(props: EntityDetailProps): React.JSX.Element {
  const participants = useSessionPartition(props.sessionStore, "participant");
  const channels = useSessionPartition(props.sessionStore, "channel");
  const runs = useSessionPartition(props.sessionStore, "run");
  const agents = useSessionPartition(props.sessionStore, "agent");
  return (
    <EntityRecord
      glyph="sessions"
      heading="Session"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      // The store answering for this id IS the record. A session with no projected
      // row is still a session the console has open, and rendering "no such
      // session" over one would contradict the store the pane is reading from.
      hasRecord={props.entity !== undefined || props.sessionStore.sessionId === props.entityId}
      degradedCause={props.degradedCause}
      degradedConsequence="every count below would be a floor rather than a total."
      absentTitle="This session is not open in the console."
      absentDetail="The identifier this pane was opened with belongs to no session the console holds. Open the session from the sidebar and its record appears here."
      facets={[
        composedCountFacet("Participants", Object.keys(participants).length),
        composedCountFacet("Channels", Object.keys(channels).length),
        composedCountFacet("Runs", Object.keys(runs).length),
        composedCountFacet("Agents", Object.keys(agents).length),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    />
  );
}
