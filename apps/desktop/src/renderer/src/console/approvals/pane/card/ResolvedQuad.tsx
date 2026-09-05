// The four facts a resolved approval leaves behind: who, what, when, and on what
// standing.
//
// Split from `ApprovalCard.tsx`, which owns the live card — the controls, the
// deadline, the act of answering — while this owns the record that answer became.
// A resolved request is no longer a question, and rendering it through the live
// card's shape would offer controls for a decision already taken.

import { DerivedFigure, WireFigure } from "../../../primitives/index.js";
import { hasCompleteResolvedQuad, type ApprovalRecord } from "../../../bridge/index.js";
import { rememberedScopeKindPhrase } from "../../../bridge/index.js";

/** The resolved quad, and the one honest thing to say when it is incomplete. */
export function ResolvedQuad(props: { readonly record: ApprovalRecord }): React.JSX.Element {
  const { record } = props;
  if (!hasCompleteResolvedQuad(record)) {
    return (
      <p className="meridian-approval-card__incomplete">
        This record is resolved and the reply did not carry every part of its resolution, so what is
        shown is less than what happened.
      </p>
    );
  }
  return (
    <dl className="meridian-approval-card__facts meridian-approval-card__facts--resolved">
      <div className="meridian-approval-card__fact">
        <dt>Resolved at</dt>
        <dd>
          <WireFigure value={record.resolvedAt ?? ""} />
        </dd>
      </div>
      <div className="meridian-approval-card__fact">
        <dt>Decision</dt>
        <dd>
          <WireFigure value={record.decision ?? ""} />
        </dd>
      </div>
      <div className="meridian-approval-card__fact">
        <dt>Approver</dt>
        <dd>
          <WireFigure value={record.approverId ?? ""} />
        </dd>
      </div>
      <div className="meridian-approval-card__fact">
        <dt>Effective scope</dt>
        <dd>
          <WireFigure value={record.effectiveScope ?? ""} />
        </dd>
      </div>
      {record.rememberedScope === undefined ? null : (
        <div className="meridian-approval-card__fact">
          <dt>Remembered scope</dt>
          <dd>
            <DerivedFigure text={rememberedScopeKindPhrase(record.rememberedScope.kind)} />
            {record.rememberedScope.pattern === undefined ? (
              <DerivedFigure text="the whole category inside that boundary" />
            ) : (
              <WireFigure value={record.rememberedScope.pattern} />
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}
