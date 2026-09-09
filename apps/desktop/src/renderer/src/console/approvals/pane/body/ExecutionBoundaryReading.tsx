// The execution-boundary section's body, in each of the four phases its read has.
//
// Split out of `ApprovalsPaneBody.tsx`, and shaped exactly like `ApprovalList` and
// `RulesRead`: the pane owns the section and its heading, and this owns what the
// section SAYS about the read behind it.
//
// THE SECTION READS THE APPROVAL PROJECTION, not a read of its own. The runs it
// describes are the runs this pane's PENDING decisions name, so the phase it renders
// is the projection's — and that is precisely why it cannot render an absence off the
// derived list alone. `partitionRecords` answers an empty `pending` for a read that is
// in flight and for one that refused as well as for one that answered with nothing, so
// a section keyed on `addressed.length === 0` told an operator "no decision is waiting,
// so no run's boundary is in question" during an outage — an assurance nobody had
// established, and `Spec-023 §Console Design (Meridian)` rule 8's exact prohibition.

import { ExecutionPostureChip, Nothing, WireFigure } from "../../../primitives/index.js";
import { type ApprovalRecord } from "../../../bridge/index.js";
import { type ReadPhase } from "../approvals-reader.js";
import { type AddressedRunPosture } from "../posture/addressed-run-postures.js";

export function ExecutionBoundaryReading(props: ExecutionBoundaryReadingProps): React.JSX.Element {
  if (props.phase.status === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The console has not asked which decisions are waiting."
        detail="The runs described here are the ones the waiting decisions name, and nothing has been read yet — so an absence here would stand in for an answer nobody has given."
      />
    );
  }
  if (props.phase.status === "loading") {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading which decisions are waiting." />
    );
  }
  if (props.phase.status === "refused") {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={props.phase.refusal.code}
        detail={props.phase.refusal.detail}
      />
    );
  }
  if (props.addressed.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="No decision is waiting, so no run's boundary is in question."
        detail="A boundary is stamped when a run reaches running, and this section reads the runs that raised the requests above."
      />
    );
  }
  return (
    <>
      {props.addressed.map((addressed) => (
        <div className="meridian-approvals__posture" key={addressed.runId}>
          <WireFigure value={addressed.runId} />
          <ExecutionPostureChip
            posture={addressed.posture}
            reading="stamped"
            runId={addressed.runId}
          />
        </div>
      ))}
    </>
  );
}

interface ExecutionBoundaryReadingProps {
  /** The projection read the addressed runs were derived from. */
  readonly phase: ReadPhase<ApprovalRecord>;
  /** The runs the pending decisions name, each with the boundary daemon stamped. */
  readonly addressed: readonly AddressedRunPosture[];
}
