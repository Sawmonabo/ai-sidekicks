// A workspace's record — the durable side of a repo mount.
//
// The three members are the repo / workspace lifecycle payload's own:
// `repoMountId`, `workspaceId`, and `actor`. The mount's health is deliberately not
// among them: the wire's mount health is a two-member union read through a
// different surface, and a record that showed a health it never read would be the
// "not checked" collapse rule 8 exists to prevent.

import { EntityRecord } from "./EntityRecord.js";
import {
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function WorkspaceEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="workspace"
      heading="Workspace"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="the state below may predate the provisioning that finished it."
      absentTitle="No workspace with this identifier is in the session."
      absentDetail="A workspace joins the record when a repo is attached and provisioning begins. Attach a repo and the workspace appears here with its mount."
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
