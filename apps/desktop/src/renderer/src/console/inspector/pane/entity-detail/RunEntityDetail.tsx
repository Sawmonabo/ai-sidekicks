// A run's record.
//
// The two members beyond the base are `runVersion` and `previousState`, which
// `RunStateChangeEvent` registers by those names. The version is rendered as a
// COUNT and the states as WIRE strings, and that split is rule 4's provenance
// signature rather than a style: a run state is a word the daemon chose and is
// shown in mono exactly as sent, while a version is a number a person reads.
//
// The record shows the run's state and never derives what may be done to it. Run
// controls are the runs pane's, gated on what the daemon declares; an inspector
// that offered one would be the second source of eligibility truth the console
// forbids.

import { EntityRecord } from "./EntityRecord.js";
import {
  countFacet,
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function RunEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="run"
      heading="Run"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="the state below may be older than the run's own, and a stale state is worse than none."
      absentTitle="No run with this identifier is in the session."
      absentDetail="A run joins the record when it is queued. Open the runs pane to see the runs this session does hold."
      facets={[
        countFacet("Run version", readBodyMember(props.entity, "runVersion"), "run version"),
        wireFacet(
          "Previous state",
          readBodyMember(props.entity, "previousState"),
          "previous state",
        ),
        wireFacet("Attributed to", props.entity?.attributedTo, "attribution"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    />
  );
}
