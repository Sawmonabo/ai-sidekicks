// An approval's record — the one kind whose expiry has three answers.
//
// A decision that never lapses is a fact, and it is a different fact from an expiry
// nobody projected: `Spec-023 §Console Design (Meridian)` §7.6 asks for "a verbatim
// expiry with an explicit 'no expiry' label", so the expiry facet answers `null`
// with the label and absence with the absence.
//
// The record shows what was decided and offers no control that decides. Approvals
// are granted from the approvals pane against the daemon's own pending set; an
// inspector that offered a decision would be deriving eligibility in the renderer.

import { EntityRecord } from "./EntityRecord.js";
import {
  expiryFacet,
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function ApprovalEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="approval"
      heading="Approval"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="a request that has since been decided could still read as pending, which is the one reading nobody should act on."
      absentTitle="No approval with this identifier is in the session."
      absentDetail="An approval joins the record when a run raises a request. The approvals pane holds the ones this session is waiting on."
      facets={[
        wireFacet("Category", readBodyMember(props.entity, "category"), "category"),
        wireFacet("Decision", readBodyMember(props.entity, "decision"), "decision"),
        expiryFacet("Expires", readBodyMember(props.entity, "expiresAt"), "expiry"),
        wireFacet("Attributed to", props.entity?.attributedTo, "attribution"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    />
  );
}
