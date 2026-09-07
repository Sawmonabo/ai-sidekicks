// A worktree's record — one checkout, bound as an execution root.
//
// It shares a payload family with the workspace and still reads differently: the
// worktree lifecycle vocabulary is its own (`creating` / `dirty` / `merged` /
// `retired`), and the checkout path — the thing an operator actually wants — is on
// no registered lifecycle member, so this record says so rather than leaving a
// reader to conclude the worktree has none.

import { EntityRecord } from "./EntityRecord.js";
import {
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function WorktreeEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="worktree"
      heading="Worktree"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="a worktree that has since been merged or retired could still read as ready."
      absentTitle="No worktree with this identifier is in the session."
      absentDetail="A worktree joins the record when the session provisions a checkout for it. Worktrees are created by the workspace they belong to, never from an inspector."
      facets={[
        wireFacet("Worktree", readBodyMember(props.entity, "worktreeId"), "worktree"),
        wireFacet("Workspace", readBodyMember(props.entity, "workspaceId"), "workspace"),
        wireFacet("Actor", readBodyMember(props.entity, "actor"), "actor"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    >
      <p className="meridian-entity-record__note">
        The checkout path is on no member the record carries, so this pane shows none. A path
        composed from an identifier would be a guess about someone else&apos;s disk.
      </p>
    </EntityRecord>
  );
}
