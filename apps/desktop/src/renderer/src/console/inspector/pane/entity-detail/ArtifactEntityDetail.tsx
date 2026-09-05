// An artifact's record — the one kind whose record carries a size.
//
// The three members are the console's own artifact summary: `name`, `contentType`,
// and `byteLength`. The size goes through the figures module's byte scaling, which
// is the only place in the console that divides by 1024 — an inspector that
// formatted its own would be the second implementation that chokepoint exists to
// prevent.

import { EntityRecord } from "./EntityRecord.js";
import {
  byteFacet,
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function ArtifactEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="artifact"
      heading="Artifact"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="an artifact that has since been deleted could still read as present."
      absentTitle="No artifact with this identifier is in the session."
      absentDetail="An artifact joins the record when a participant or an agent publishes one. Nothing about this identifier is held, so there is nothing to open."
      facets={[
        wireFacet("Name", readBodyMember(props.entity, "name"), "name"),
        wireFacet("Content type", readBodyMember(props.entity, "contentType"), "content type"),
        byteFacet("Size", readBodyMember(props.entity, "byteLength"), "byte length"),
        wireFacet("Attributed to", props.entity?.attributedTo, "attribution"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    />
  );
}
