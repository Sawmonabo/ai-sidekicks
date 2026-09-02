// An agent's record.
//
// `name` is the member `agent.attached` registers, and it is the only one of this
// kind's own members the corpus names today. The attach-time configuration axes an
// agent also carries — its posture, its allowlist, its paying account — are stamped
// on a table whose read the console does not have, so they are absent here rather
// than guessed at from a body member nobody writes.

import { EntityRecord } from "./EntityRecord.js";
import {
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function AgentEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="agent"
      heading="Agent"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="this agent's record may be missing the attachment that last changed it."
      absentTitle="No agent with this identifier is in the session."
      absentDetail="An agent joins the record when it is attached to the session. Attaching one is done from the session's own surface, not from an inspector."
      facets={[
        wireFacet("Name", readBodyMember(props.entity, "name"), "name"),
        wireFacet("Attributed to", props.entity?.attributedTo, "attribution"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    />
  );
}
