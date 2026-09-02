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
  PROPOSAL_MEMBER_UNSUPPLIED_COPY,
  proposalBlobRows,
  type PreparedProposal,
} from "./prepared-proposal.js";

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
        {/*
          Three absences on this surface and they are three DIFFERENT absences, which
          is the whole of rule 8 applied to one card. `not-checked` is "no reply
          supplied this member" — the model names which four those are — and `empty`
          below is "a list arrived and it was empty". A title rendered as blank text
          would have said the proposal is untitled, which nothing read.
        */}
        {proposal.title === undefined ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title={PROPOSAL_MEMBER_UNSUPPLIED_COPY.title}
          />
        ) : (
          <h4 className="meridian-proposal__title">{proposal.title}</h4>
        )}
        <span className="meridian-proposal__range">
          <WireFigure value={proposal.headBranch} /> into <WireFigure value={proposal.baseBranch} />
        </span>
      </div>
      <p className="meridian-proposal__lineage">{ONE_CUMULATIVE_PROPOSAL_COPY}</p>

      <details className="meridian-proposal-gate__detail">
        <summary className="meridian-proposal-gate__detail-summary">Body and trailers</summary>
        {proposal.body === undefined ? (
          <Nothing
            kind="not-checked"
            placement="surface"
            title={PROPOSAL_MEMBER_UNSUPPLIED_COPY.body}
          />
        ) : (
          <p className="meridian-proposal__body">{proposal.body}</p>
        )}
        {renderTrailers(proposal.trailers)}
      </details>

      <details className="meridian-proposal-gate__detail">
        <summary className="meridian-proposal-gate__detail-summary">
          Files{" "}
          {/*
            The count is drawn from a list that arrived, and from nothing else. A
            `0` beside an unsupplied list would be a figure the console computed over
            an absence, which is the one thing a derived figure may never be.
          */}
          {proposal.changedPaths === undefined ? null : (
            <DerivedFigure text={formatCount(proposal.changedPaths.length)} />
          )}
        </summary>
        {renderChangedPaths(proposal.changedPaths, props.onOpenChangedPath)}
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

/**
 * The trailer list, in its three states.
 *
 * A function rather than a third nested ternary in the body above: the two list
 * members share one shape — unsupplied, supplied-and-empty, supplied — and writing
 * it twice inline is how the two absences come to be worded differently.
 */
function renderTrailers(trailers: readonly string[] | undefined): React.JSX.Element {
  if (trailers === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title={PROPOSAL_MEMBER_UNSUPPLIED_COPY.trailers}
      />
    );
  }
  if (trailers.length === 0) {
    return <Nothing kind="empty" placement="inline" title="No attribution trailers." />;
  }
  return (
    <ul className="meridian-proposal__trailers">
      {trailers.map((trailer) => (
        <li key={trailer}>
          <WireFigure value={trailer} />
        </li>
      ))}
    </ul>
  );
}

/** The changed-path list, in the same three states, with the diff half where offered. */
function renderChangedPaths(
  changedPaths: readonly string[] | undefined,
  onOpenChangedPath: ((path: string) => void) | undefined,
): React.JSX.Element {
  if (changedPaths === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title={PROPOSAL_MEMBER_UNSUPPLIED_COPY.changedPaths}
      />
    );
  }
  if (changedPaths.length === 0) {
    return <Nothing kind="empty" placement="inline" title="No file changes in this proposal." />;
  }
  return (
    <ul className="meridian-proposal__paths">
      {changedPaths.map((path) => (
        <li key={path}>
          {onOpenChangedPath === undefined ? (
            <WireFigure value={path} />
          ) : (
            <button
              type="button"
              className="meridian-proposal__path-link"
              onClick={() => {
                onOpenChangedPath(path);
              }}
            >
              <WireFigure value={path} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
