import { Chip, DerivedFigure, Nothing, WireFigure, formatCount } from "../../primitives/index.js";
import {
  CHANGE_REQUEST_STATE_PRESENTATION,
  CHECK_STATUS_PRESENTATION,
  MERGEABILITY_PRESENTATION,
  NO_REVIEW_DECISION_COPY,
  REVIEW_DECISION_PRESENTATION,
  checkRollup,
  type ProposalStatusReading,
} from "../mounts/hosting-status.js";

/**
 * The three trichotomies, always visible, because they are the decision.
 *
 * The check rollup opens as counts rather than as a list: this gate's density puts
 * the rollup on the face and the full list one click away, on `Spec-023 §Meridian, the
 * design language` rule 7 ("secondary controls live one click away").
 */
export function StatusRollup(props: { readonly status: ProposalStatusReading }): React.JSX.Element {
  const { status } = props;
  const statePresentation = CHANGE_REQUEST_STATE_PRESENTATION[status.state];
  const mergeabilityPresentation = MERGEABILITY_PRESENTATION[status.mergeable];
  const rollup = checkRollup(status.checks);
  const reviewPresentation =
    status.reviewDecision === undefined
      ? undefined
      : REVIEW_DECISION_PRESENTATION[status.reviewDecision];

  return (
    <div className="meridian-proposal-gate__status">
      <div className="meridian-proposal-gate__chips">
        <Chip tone={statePresentation.tone} label={status.state} mono />
        <Chip tone={mergeabilityPresentation.tone} label={status.mergeable} mono />
        <Chip
          tone={rollup.tone}
          label={`${formatCount(rollup.countByStatus.success)}/${formatCount(rollup.total)} checks`}
          glyph="check"
        />
        {reviewPresentation === undefined ? (
          // Absence of a review decision is "no decision yet" and never a fourth
          // value, so it renders as an absence rather than as a chip.
          <Nothing kind="empty" placement="inline" title={NO_REVIEW_DECISION_COPY} />
        ) : (
          <Chip tone={reviewPresentation.tone} label={status.reviewDecision ?? ""} mono />
        )}
      </div>
      <p className="meridian-proposal-gate__meaning">{mergeabilityPresentation.meaning}</p>
      {status.checks.length === 0 ? null : (
        <details className="meridian-proposal-gate__detail">
          <summary className="meridian-proposal-gate__detail-summary">
            Checks <DerivedFigure text={formatCount(status.checks.length)} />
          </summary>
          <ul className="meridian-proposal-gate__checks">
            {status.checks.map((check) => (
              <li key={check.name}>
                <Chip
                  tone={CHECK_STATUS_PRESENTATION[check.status].tone}
                  label={check.status}
                  mono
                />
                <WireFigure value={check.name} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
