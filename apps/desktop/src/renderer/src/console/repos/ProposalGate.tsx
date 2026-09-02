// The change proposal gate: exactly what would be sent to the git host, held where a
// participant can approve it first.
//
// `Spec-023 §Console Design (Meridian)` §10.7. Four things about this file are
// decisions rather than implementation, and each is load-bearing:
//
// 1. IT RENDERS, AND IT DOES NOT READ. The state arrives as a prop and the acts leave
//    as callbacks, exactly as `ArtifactsPanel` takes its four arms. Every read and
//    every write behind this gate — `gitflow.branchContextRead`, `gitflow.prPrepare`,
//    `gitflow.gitActionExecute` — is unregistered: `packages/contracts` carries no
//    `gitflow` module at all, and the growth port carries exactly ONE of the three,
//    `gitActionExecute`, under the `gitflow-actions` slate row. A gate that called the
//    port itself would own an effect to render the one arm it already takes as a prop.
//
// 2. NOTHING HERE DECIDES WHO MAY ACT. `docs/architecture/contracts/error-contracts.md`
//    registers no `gitflow` namespace, so a failed action arrives as an ordinary
//    unsuccessful result and renders as a first-class failure carrying the daemon's own
//    message text. Controls are offered; the refusal renders beside the one pressed.
//    Greying a control out would mean holding a second copy of the daemon's rule.
//
// 3. BASE AND HEAD COME FROM THE CONTEXT, ALWAYS. Not from the selected pane, not from
//    a tab, not from the focused view. There is no prop on this component through which
//    a selection could reach it, which is that prohibition made structural rather than
//    remembered.
//
// 4. THE DEGRADED ARM IS A FEATURE AND READS LIKE ONE. Hosting being unavailable still
//    produces a proposal-ready summary and a diff bundle, so that arm renders the whole
//    summary plus the bundle's path — it is not an error page and carries no refusal
//    styling.
//
// THE PREPARATION GATE IS THE ORDER OF THIS FILE. `prepare-proposal` is offered before
// `push`, the prepared proposal is rendered above the acts, and the remote-mutating act
// sits under the thing it would send. A layout that put the button above the payload
// would be inviting approval of something not yet on screen.

import { useId, useState } from "react";

import {
  Chip,
  DerivedFigure,
  Glyph,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatCount,
} from "../primitives/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import {
  ACTION_FAILURE_COPY,
  BRANCH_CONTEXT_UNREAD_REASON,
  CHANGE_REQUEST_STATE_PRESENTATION,
  CHECK_STATUS_PRESENTATION,
  HOSTING_UNAVAILABLE_COPY,
  MERGEABILITY_PRESENTATION,
  NO_BRANCH_CONTEXT_REASON,
  NO_REVIEW_DECISION_COPY,
  ONE_CUMULATIVE_PROPOSAL_COPY,
  PROPOSAL_ACTIONS,
  PROPOSAL_ACTION_PRESENTATION,
  REVIEW_DECISION_PRESENTATION,
  branchContextAssociationReading,
  checkRollup,
  proposalBlobRows,
  type BranchContextReading,
  type CheckoutConflict,
  type PreparedProposal,
  type ProposalAction,
  type ProposalGateState,
  type ProposalStatusReading,
} from "./proposal-model.js";

export interface ProposalGateProps {
  readonly state: ProposalGateState;
  /**
   * The blocking choice an incompatible checkout raises.
   *
   * A SEPARATE prop rather than a seventh state arm, because it blocks a context that
   * is otherwise fully readable: the summary stays on screen underneath while the
   * choice is put, which is what makes the choice answerable.
   */
  readonly checkoutConflict?: CheckoutConflict | undefined;
  readonly onResolveCheckoutConflict?: ((optionId: string) => void) | undefined;
  /** Send one modelled action. The three offers, and there is no fourth entry point. */
  readonly onRequestAction?: ((action: ProposalAction) => void) | undefined;
  /** What the last action produced, keyed by the action that produced it. */
  readonly actionRefusals?: ReadonlyMap<ProposalAction, ConsoleRefusal> | undefined;
  /** Open a changed path in the diff pane. Absent where no diff exists for it. */
  readonly onOpenChangedPath?: ((path: string) => void) | undefined;
}

const GATE_GLYPH_SIZE = 14;

export function ProposalGate(props: ProposalGateProps): React.JSX.Element {
  const headingId = useId();
  return (
    <section className="meridian-proposal-gate" aria-labelledby={headingId}>
      <header className="meridian-proposal-gate__head">
        <h3 className="meridian-proposal-gate__heading" id={headingId}>
          <Glyph name="workflow" size={GATE_GLYPH_SIZE} />
          Change proposal
        </h3>
        {props.state.kind === "prepared" ? (
          // The detected host, in the host's own word. §10.7: the provider is
          // auto-detected from the git remote URL, so this is a REPORT and never a
          // picker — there is no control here that could change it.
          <span className="meridian-proposal-gate__host">
            detected host <WireFigure value={props.state.detectedHost} />
          </span>
        ) : null}
      </header>
      {renderGateBody(props)}
    </section>
  );
}

/** The gate's six arms. Each absence is its own kind; none stands in for another. */
function renderGateBody(props: ProposalGateProps): React.JSX.Element {
  const { state } = props;
  if (state.kind === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No branch context has been read."
        detail="Reading a branch context, preparing a proposal, and executing a git action are not registered on the bridge yet, so nothing has been asked for and nothing is being reported as absent."
      />
    );
  }
  if (state.kind === "no-context") {
    // The mode is the reason, and it is stated rather than shown as a disabled form.
    // A writable mode with no context is a read that has not happened, so the two
    // sentences are different sentences.
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={`No writable branch context in ${state.executionMode} mode.`}
        detail={NO_BRANCH_CONTEXT_REASON[state.executionMode] ?? BRANCH_CONTEXT_UNREAD_REASON}
      />
    );
  }
  if (state.kind === "preparing") {
    return <Nothing kind="computing" placement="surface" title="Preparing the proposal." />;
  }
  if (state.kind === "refused") {
    // A first-class failure state and never a silent no-op. The daemon's own message
    // text renders verbatim; there is no `gitflow` error namespace to carry a code.
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={ACTION_FAILURE_COPY}
        detail={state.message}
      />
    );
  }
  if (state.kind === "hosting-unavailable") {
    return (
      <div className="meridian-proposal-gate__body">
        <p className="meridian-proposal-gate__degraded" role="status">
          <Glyph name="alert" size={GATE_GLYPH_SIZE} />
          {HOSTING_UNAVAILABLE_COPY}
        </p>
        <BranchContextSummary context={state.context} />
        <ProposalSummary proposal={state.proposal} onOpenChangedPath={props.onOpenChangedPath} />
        <p className="meridian-proposal-gate__bundle">
          Diff bundle <WireFigure value={state.bundlePath} />
        </p>
      </div>
    );
  }
  return (
    <div className="meridian-proposal-gate__body">
      <BranchContextSummary context={state.context} />
      {state.status === undefined ? null : <StatusRollup status={state.status} />}
      {state.proposal === undefined ? (
        <Nothing
          kind="empty"
          placement="surface"
          title="No proposal has been prepared."
          detail={ONE_CUMULATIVE_PROPOSAL_COPY}
        />
      ) : (
        <ProposalSummary proposal={state.proposal} onOpenChangedPath={props.onOpenChangedPath} />
      )}
      {props.checkoutConflict === undefined ? null : (
        <CheckoutConflictChoice
          conflict={props.checkoutConflict}
          onResolve={props.onResolveCheckoutConflict}
        />
      )}
      <ProposalActions
        onRequestAction={props.onRequestAction}
        actionRefusals={props.actionRefusals}
        isBlocked={props.checkoutConflict !== undefined}
      />
    </div>
  );
}

/**
 * The four named values and the association.
 *
 * Every one of them is a wire string in mono: base and head are branch names the
 * daemon resolved, and a renderer that normalised or shortened either would be showing
 * a branch the host does not have.
 */
function BranchContextSummary(props: {
  readonly context: BranchContextReading;
}): React.JSX.Element {
  const association = branchContextAssociationReading(props.context);
  return (
    <dl className="meridian-proposal-gate__context">
      <div className="meridian-proposal-gate__pair">
        <dt>Base</dt>
        <dd>
          <WireFigure value={props.context.baseBranch} />
        </dd>
      </div>
      <div className="meridian-proposal-gate__pair">
        <dt>Head</dt>
        <dd>
          <WireFigure value={props.context.headBranch} />
        </dd>
      </div>
      <div className="meridian-proposal-gate__pair">
        <dt>Upstream</dt>
        <dd>
          {props.context.upstreamRef === undefined ? (
            <Nothing kind="empty" placement="inline" title="No upstream set." />
          ) : (
            <WireFigure value={props.context.upstreamRef} />
          )}
        </dd>
      </div>
      <div className="meridian-proposal-gate__pair">
        <dt>{association.label}</dt>
        <dd>
          {association.boundId === undefined ? (
            // `in-place` binds no separate root, and a `worktree`-mode context whose
            // id did not arrive is a hole the type says cannot exist. Both say what
            // they are rather than rendering an empty cell.
            <DerivedFigure text={association.meaning} />
          ) : (
            <WireFigure value={association.boundId} title={association.meaning} />
          )}
        </dd>
      </div>
    </dl>
  );
}

/**
 * The three trichotomies, always visible, because they are the decision.
 *
 * The check rollup opens as counts rather than as a list: §10.7's density note puts
 * the rollup on the face and the full list one click away.
 */
function StatusRollup(props: { readonly status: ProposalStatusReading }): React.JSX.Element {
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

/**
 * The prepared proposal, rendered before any remote mutation.
 *
 * Title, base, head, and state are on the face; body, trailers, the file list, and the
 * untyped blob are one click away — §10.7's density split exactly.
 */
function ProposalSummary(props: {
  readonly proposal: PreparedProposal;
  readonly onOpenChangedPath: ((path: string) => void) | undefined;
}): React.JSX.Element {
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

/**
 * The blocking choice.
 *
 * The daemon's reason renders verbatim and its options are the only ways forward
 * offered — the console resolves nothing automatically and adds no option of its own,
 * which is why the buttons are built from the list rather than from a union here.
 */
function CheckoutConflictChoice(props: {
  readonly conflict: CheckoutConflict;
  readonly onResolve: ((optionId: string) => void) | undefined;
}): React.JSX.Element {
  const legendId = useId();
  return (
    <div
      className="meridian-proposal-gate__conflict"
      role="group"
      aria-labelledby={legendId}
      aria-live="polite"
    >
      <p className="meridian-proposal-gate__conflict-reason" id={legendId}>
        <Glyph name="alert" size={GATE_GLYPH_SIZE} />
        {props.conflict.reason}
      </p>
      <div className="meridian-proposal-gate__conflict-options">
        {props.conflict.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className="meridian-proposal-gate__act"
            onClick={() => props.onResolve?.(option.optionId)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The three acts, in the order the gate enforces.
 *
 * `isBlocked` is not an eligibility derivation: it is the presence of an unanswered
 * blocking choice on this very surface, which `Spec-011 §Fallback Behavior` requires
 * to be answered before proceeding. Every other reason an act might fail is the
 * daemon's, is not consulted here, and renders as the refusal beside the act.
 */
function ProposalActions(props: {
  readonly onRequestAction: ((action: ProposalAction) => void) | undefined;
  readonly actionRefusals: ReadonlyMap<ProposalAction, ConsoleRefusal> | undefined;
  readonly isBlocked: boolean;
}): React.JSX.Element | null {
  const [actionAwaitingConfirm, setActionAwaitingConfirm] = useState<ProposalAction | undefined>(
    undefined,
  );
  if (props.onRequestAction === undefined) {
    return null;
  }
  return (
    <div className="meridian-proposal-gate__acts" role="group" aria-label="Git actions">
      {PROPOSAL_ACTIONS.map((action) => {
        const presentation = PROPOSAL_ACTION_PRESENTATION[action];
        const refusal = props.actionRefusals?.get(action);
        const isAwaitingConfirm = actionAwaitingConfirm === action;
        return (
          <div className="meridian-proposal-gate__act-row" key={action}>
            <button
              type="button"
              className={
                action === "prepare-proposal"
                  ? "meridian-proposal-gate__act meridian-proposal-gate__act--primary"
                  : "meridian-proposal-gate__act"
              }
              // The blocking choice is the one condition this surface owns, so it is
              // the one condition that disables an act here.
              disabled={props.isBlocked}
              onClick={() => setActionAwaitingConfirm(isAwaitingConfirm ? undefined : action)}
              aria-expanded={isAwaitingConfirm}
            >
              {presentation.label}
            </button>
            {isAwaitingConfirm ? (
              <div className="meridian-proposal-gate__confirm">
                {/* The consequence is stated before the act, never after it. */}
                <p className="meridian-proposal-gate__consequence">{presentation.consequence}</p>
                <button
                  type="button"
                  className="meridian-proposal-gate__act"
                  onClick={() => {
                    setActionAwaitingConfirm(undefined);
                    props.onRequestAction?.(action);
                  }}
                >
                  {presentation.label} now
                </button>
                <button
                  type="button"
                  className="meridian-proposal-gate__act"
                  onClick={() => setActionAwaitingConfirm(undefined)}
                >
                  Cancel
                </button>
              </div>
            ) : null}
            {refusal === undefined ? null : (
              // Inline, beside the control that produced it, and the control stays:
              // the act did not happen and the participant may try another one.
              <InlineRefusal code={refusal.code} detail={refusal.detail} />
            )}
          </div>
        );
      })}
    </div>
  );
}
