// A participant's record, and the one relation the inspector can compose today.
//
// `ConsoleEntity.attributedTo` is TYPED by the store, so counting the runs and the
// approvals a session attributes to this participant is a read of the projection
// rather than a guess at a body member no projector has written. There is one
// participant on a session and no event carries a role or a handle for them, so the
// record is the two composed counts and the touch instant and nothing else.

import { useMemo } from "react";

import { useSessionPartition } from "../../../store/index.js";
import { EntityRecord } from "./EntityRecord.js";
import {
  composedCountFacet,
  countAttributedTo,
  instantFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function ParticipantEntityDetail(props: EntityDetailProps): React.JSX.Element {
  const runs = useSessionPartition(props.sessionStore, "run");
  const approvals = useSessionPartition(props.sessionStore, "approval");
  const { entityId } = props;
  const attributedRunCount = useMemo(() => countAttributedTo(runs, entityId), [runs, entityId]);
  const attributedApprovalCount = useMemo(
    () => countAttributedTo(approvals, entityId),
    [approvals, entityId],
  );
  return (
    <EntityRecord
      glyph="member"
      heading="Participant"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="the two counts below would understate what this participant has done."
      absentTitle="No participant with this identifier is in the session."
      absentDetail="A participant enters the record when the session first attributes work to them. Until then there is nothing to show."
      facets={[
        composedCountFacet("Runs attributed", attributedRunCount),
        composedCountFacet("Approvals attributed", attributedApprovalCount),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    />
  );
}
