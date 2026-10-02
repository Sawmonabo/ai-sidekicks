// A workspace's record: the durable side of a repo mount.
//
// The mount's health is deliberately not a facet: a record showing a health it never read
// would draw a "not checked" absence as if it were a reading.

import { EntityRecord } from "./EntityRecord.js";
import {
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "../entity-facets.js";

/** The workspace record body: repo mount, workspace, actor and last touch. */
export function WorkspaceEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="workspace"
      heading="Workspace"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialized={props.isInitialized}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="the state below may predate the preparation that finished it."
      absentTitle="No workspace with this identifier is in the session."
      absentDetail="A workspace joins the record when a repo is attached and preparation begins. Attach a repo and the workspace appears here with its mount."
      facets={[
        wireFacet("Repo mount", readBodyMember(props.entity, "repoMountId"), "repo mount"),
        wireFacet("Workspace", readBodyMember(props.entity, "workspaceId"), "workspace"),
        wireFacet("Actor", readBodyMember(props.entity, "actor"), "actor"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    />
  );
}
