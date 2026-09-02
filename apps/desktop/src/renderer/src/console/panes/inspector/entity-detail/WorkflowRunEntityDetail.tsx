// A workflow run's record.
//
// A parked phase is the member worth having: a workflow run that stopped and said
// why is legible, and one that stopped silently is the failure mode the park
// surface exists to close. So the park reason is a facet of its own, and its
// absence carries the sentence that distinguishes "not parked" from "parked and we
// were not told why".

import { EntityRecord } from "./EntityRecord.js";
import {
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function WorkflowRunEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="workflow"
      heading="Workflow run"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="a phase that has since parked or been cancelled could still read as running."
      absentTitle="No workflow run with this identifier is in the session."
      absentDetail="A workflow run joins the record when its definition is started. Definitions are started from the workflow surface, never from an inspector."
      facets={[
        wireFacet("Definition", readBodyMember(props.entity, "definitionId"), "definition"),
        wireFacet("Phase", readBodyMember(props.entity, "phase"), "phase"),
        wireFacet("Park reason", readBodyMember(props.entity, "parkReason"), "park reason"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    >
      <p className="meridian-entity-record__note">
        A run with no park reason is a run this record was not told is parked. It is not a claim
        that the run is moving.
      </p>
    </EntityRecord>
  );
}
