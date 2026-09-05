// A repo's record — the mount a session attached, before any checkout hangs off it.
//
// The repo card is the repos family's, and this is the record its card opens: the
// address union admits a repo reference for the inspector, so the table below the
// pane has to answer for the kind whether or not that family has landed. It reads
// the two members the repo / workspace / worktree lifecycle payload registers —
// `repoMountId` and `actor` — and invents nothing beside them, because the mount's
// remote, branch, and health reach a person through reads this record does not make.

import { EntityRecord } from "./EntityRecord.js";
import {
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function RepoEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="repo"
      heading="Repo"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="a mount that has since been detached could still read as attached."
      absentTitle="No repo with this identifier is in the session."
      absentDetail="A repo joins the record when it is attached to the session. Attach one from the repos section and its mount appears here."
      facets={[
        wireFacet("Repo mount", readBodyMember(props.entity, "repoMountId"), "repo mount"),
        wireFacet("Actor", readBodyMember(props.entity, "actor"), "actor"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    >
      <p className="meridian-entity-record__note">
        The remote, the default branch, and the mount&apos;s health are on no member this record
        reads. They reach a person through the repos section&apos;s own read, and a record that
        showed them from here would be showing a second answer to one question.
      </p>
    </EntityRecord>
  );
}
