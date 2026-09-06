// One answered read, rendered in each of its four phases.
//
// Split out of `ApprovalsPane.tsx` because it is a different job from composing the
// pane: the pane decides WHICH records belong in which section, and this decides what
// a section says about the read behind it. The four phases are kept apart
// deliberately — "nobody asked", "the read is in flight", "the read answered and
// found none", and "the read was refused" are four different next moves for the
// operator, and `Spec-023 §Console Design (Meridian)` rule 8 forbids collapsing any
// two of them.

import { Nothing, formatCount } from "../../../primitives/index.js";
import { type ConsoleRefusal } from "../../../core/index.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { ProviderAskFraming } from "./ProviderAskFraming.js";
import { countAsksMissingDeadline, type ProviderAsk } from "./provider-ask.js";
import { type ApprovalRecord } from "../../../bridge/index.js";
import { type ReadPhase } from "../approvals-reader.js";
import { type ApprovalResolveRequest } from "../approvals-wire.js";
import { AsksMissingDeadline } from "./AsksMissingDeadline.js";

interface ApprovalListProps {
  readonly phase: ReadPhase<ApprovalRecord>;
  readonly records: readonly ApprovalRecord[];
  readonly emptyTitle: string;
  readonly emptyDetail: string;
  readonly snapshotResolving: ReadonlySet<string>;
  readonly refusalByApprovalId: ReadonlyMap<string, ConsoleRefusal>;
  /** The provider-ask origin of each record the store holds one for. */
  readonly askByApprovalId: ReadonlyMap<string, ProviderAsk>;
  readonly nowMilliseconds: number;
  readonly onResolve: (request: ApprovalResolveRequest) => void;
}

/**
 * One read, rendered in each of its four phases.
 *
 * The four are kept apart deliberately: "nobody asked", "the read is in flight",
 * "the read answered and found none", and "the read was refused" are four different
 * next moves for the operator, and rule 8 forbids collapsing any two of them.
 */
export function ApprovalList(props: ApprovalListProps): React.JSX.Element {
  if (props.phase.status === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The console has not asked what needs a decision."
        detail="Nothing has been read yet, so an empty list here would stand in for an answer nobody has given."
      />
    );
  }
  if (props.phase.status === "loading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading the approval queue." />;
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
  if (props.records.length === 0) {
    // Two independent facts, and the render has to be able to say both. An answered
    // read whose records this build could not decode is NOT a served empty set, and
    // reporting it as one tells an operator that nothing needs them while requests
    // may be waiting — rule 8's conflation rule, applied to one render.
    return props.phase.unreadableCount > 0 ? (
      <Nothing
        kind="error"
        placement="surface"
        title="Part of this read could not be decoded."
        detail={`The daemon answered and ${formatCount(props.phase.unreadableCount)} of the records it returned are shaped in a way this build cannot read, so this list is empty for that reason rather than because nothing is here.`}
      />
    ) : (
      <Nothing
        kind="empty"
        placement="surface"
        title={props.emptyTitle}
        detail={props.emptyDetail}
      />
    );
  }
  return (
    <div className="meridian-approvals__cards">
      {props.phase.unreadableCount > 0 ? (
        <p className="meridian-approvals__unreadable">
          The reply carried records this build could not read, so this list is shorter than what the
          daemon returned.
        </p>
      ) : null}
      <AsksMissingDeadline
        count={countAsksMissingDeadline(
          props.records.map((record) => props.askByApprovalId.get(record.approvalRequestId)),
        )}
      />
      {props.records.map((record) => {
        // One card either way. The framing is a BODY the card already reserves, not
        // a second card type, so a provider ask and a direct request are answered by
        // the same two controls and a record the store holds no entity for renders
        // exactly as it did before this fold existed.
        const ask = props.askByApprovalId.get(record.approvalRequestId);
        return (
          <ApprovalCard
            key={record.approvalRequestId}
            record={record}
            isResolving={props.snapshotResolving.has(record.approvalRequestId)}
            refusal={props.refusalByApprovalId.get(record.approvalRequestId)}
            onResolve={props.onResolve}
          >
            {ask === undefined ? null : (
              <ProviderAskFraming
                ask={ask}
                requestedResource={record.resourceDescriptor}
                nowMilliseconds={props.nowMilliseconds}
              />
            )}
          </ApprovalCard>
        );
      })}
    </div>
  );
}
