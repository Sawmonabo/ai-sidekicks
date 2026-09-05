// The artifacts group's door: the manifest a session's artifacts are read as, and
// the panel that draws it.
//
// A DOOR BECAUSE IT HAS READERS OUTSIDE THE GROUP, and only for that reason. The
// artifact PANE is a different directory of this same family — `panes/artifact/` —
// and it reads this group's model in nine places and its panel in one, so a reader
// asking where the artifact manifest lives has one answer instead of ten relative
// paths of varying depth. The family's other four groups publish no door: their
// modules are read from `repos/` itself and from their own siblings, and a door
// nothing outside the group reads is a dead export the structure gate reports. The
// same rule inside the group: a name only a test reaches is not published here — the
// test reads the module that declares it, which is nearer anyway.
//
// THE FAMILY DOOR DOES NOT RE-EXPORT THROUGH THIS ONE. `repos/index.ts` publishes
// two cross-FAMILY seams and neither is here; if one ever were, it would name the
// module that declares it rather than this door, because a door re-exported from a
// door is the barrel chain the layering gate refuses.

export { ArtifactsPanel } from "./ArtifactsPanel.js";
export {
  ARTIFACT_STATE_PRESENTATION,
  ARTIFACT_VISIBILITY_PRESENTATION,
  artifactDeleteReceiptSentence,
  artifactManifestRowFromSummary,
  artifactProducerLabel,
  artifactReplicationPresentation,
  type ArtifactDeleteReceipt,
  type ArtifactManifestRow,
  type ArtifactsPanelState,
} from "./artifact-model.js";
