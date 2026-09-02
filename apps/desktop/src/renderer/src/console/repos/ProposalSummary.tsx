// One prepared proposal, rendered before any remote mutation.
//
// `Spec-023 §Console Design (Meridian)` §10.7 requires the proposal to be generated and
// reviewable BEFORE anything leaves the machine, and fixes its density: "The gate opens
// on base, head, title, and the check rollup. Body, trailers, and the full file list are
// one click away." This module is the second half of that sentence, and it is its own
// file rather than a block inside `ProposalGate.tsx` because it is a second surface
// rather than a second arm — the gate renders one of six states, and exactly two of them
// (`prepared` and `hosting-unavailable`) mount this, unchanged, so a proposal reads the
// same whether the host is reachable or not.
//
// THE BLOB IS DISPLAY DATA AND THE MODEL IS WHAT MAKES IT SO. §10.7's leverage note:
// the proposal is rendered from an untyped `proposalBlob`, "so the renderer treats
// unknown keys as inert display data and never as instructions". `proposalBlobRows`
// stringifies every value before it reaches this file, so nothing in the list below can
// be a handler, a URL the console follows, or markup — a key named `action` renders as
// the text of its value and as nothing else. This file re-derives none of that.

import { Chip, DerivedFigure, Nothing, WireFigure, formatCount } from "../primitives/index.js";
import {
  ONE_CUMULATIVE_PROPOSAL_COPY,
  proposalBlobRows,
  type PreparedProposal,
} from "./proposal-model.js";

/**
 * The prepared proposal, rendered before any remote mutation.
 *
 * Title, base, head, and state are on the face; body, trailers, the file list, and the
 * untyped blob are one click away — §10.7's density split exactly.
 */
export interface ProposalSummaryProps {
  readonly proposal: PreparedProposal;
  /** Open a changed path in the diff pane. Absent where no diff exists for it. */
  readonly onOpenChangedPath?: ((path: string) => void) | undefined;
}

export function ProposalSummary(props: ProposalSummaryProps): React.JSX.Element {
  const { proposal } = props;
  const blobRows = proposalBlobRows(proposal.blob);
  return (
    <article className="meridian-proposal" aria-label="Prepared proposal">
      <div className="meridian-proposal__face">
        <Chip label={proposal.state} mono glyph="workflow" />
        <h4 className="meridian-proposal__title">{proposal.title}</h4>
        <span className="meridian-proposal__range">
          <WireFigure value={proposal.headBranch} /> into <WireFigure value={proposal.baseBranch} />
        </span>
      </div>
      <p className="meridian-proposal__lineage">{ONE_CUMULATIVE_PROPOSAL_COPY}</p>

      <details className="meridian-proposal-gate__detail">
        <summary className="meridian-proposal-gate__detail-summary">Body and trailers</summary>
        <p className="meridian-proposal__body">{proposal.body}</p>
        {proposal.trailers.length === 0 ? (
          <Nothing kind="empty" placement="inline" title="No attribution trailers." />
        ) : (
          <ul className="meridian-proposal__trailers">
            {proposal.trailers.map((trailer) => (
              <li key={trailer}>
                <WireFigure value={trailer} />
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="meridian-proposal-gate__detail">
        <summary className="meridian-proposal-gate__detail-summary">
          Files <DerivedFigure text={formatCount(proposal.changedPaths.length)} />
        </summary>
        {proposal.changedPaths.length === 0 ? (
          <Nothing kind="empty" placement="inline" title="No file changes in this proposal." />
        ) : (
          <ul className="meridian-proposal__paths">
            {proposal.changedPaths.map((path) => (
              <li key={path}>
                {props.onOpenChangedPath === undefined ? (
                  <WireFigure value={path} />
                ) : (
                  <button
                    type="button"
                    className="meridian-proposal__path-link"
                    onClick={() => props.onOpenChangedPath?.(path)}
                  >
                    <WireFigure value={path} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>

      {blobRows.length === 0 ? null : (
        <details className="meridian-proposal-gate__detail">
          <summary className="meridian-proposal-gate__detail-summary">
            Everything else the host was given
          </summary>
          {/*
            Inert display data, and the model is what makes it inert: every value
            arrives here already stringified, so nothing in this list can be a handler,
            a URL the console follows, or markup. A key called `action` renders as the
            text of its value and as nothing else.
          */}
          <dl className="meridian-proposal__blob">
            {blobRows.map((row) => (
              <div className="meridian-proposal-gate__pair" key={row.key}>
                <dt>
                  <WireFigure value={row.key} />
                </dt>
                <dd>
                  <WireFigure value={row.text} />
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </article>
  );
}
