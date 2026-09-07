// A workflow definition's record.
//
// A definition is not a run of one, which is why it is its own kind and its own
// record: a definition is authored, versioned, and scoped and outlives every run
// of it, so the members worth showing are the ones that identify WHICH definition
// and which version of it a run would pin.
//
// The members are `WorkflowDefinitionSummary`'s, quoted by their registered names
// (`bridge/wire-shapes/workflow-projection.ts`, owned by `Spec-017 §Interfaces And Contracts`).
// `scopeRef` is deliberately NOT among them: what a `project`-scoped reference
// resolves against is the `workflow-definition-scope` row of the growth slate, and
// a record that rendered the reference would be asserting a meaning the wire has
// not registered. The scope itself is a closed word the daemon chose, so it is
// shown wire-verbatim and left to stand for itself.

import { EntityRecord } from "./EntityRecord.js";
import {
  countFacet,
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function WorkflowDefinitionEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="workflow"
      heading="Workflow definition"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="a definition edited since the last read could still show its previous version."
      absentTitle="No workflow definition with this identifier is in the session."
      absentDetail="A definition joins the record when it is authored or shared into this session. Definitions are authored on the workflow surface, never from an inspector."
      facets={[
        wireFacet("Name", readBodyMember(props.entity, "name"), "name"),
        wireFacet("Scope", readBodyMember(props.entity, "scope"), "scope"),
        countFacet(
          "Latest version",
          readBodyMember(props.entity, "latestVersionNumber"),
          "latest version number",
        ),
        wireFacet(
          "Latest version id",
          readBodyMember(props.entity, "latestWorkflowVersionId"),
          "latest version id",
        ),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    >
      <p className="meridian-entity-record__note">
        The version id is what a run start pins, and the number beside it is what a version read
        addresses. The console passes both through and composes neither.
      </p>
    </EntityRecord>
  );
}
