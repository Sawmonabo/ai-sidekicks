// The change proposal gate: exactly what would be sent to the git host, held where a
// participant can approve it first.
//
// THE GATE'S COMPOSITION IS THIS FAMILY'S, stated across the modules that obey it,
// because `Spec-023 §Console Design (Meridian)` puts a surface's composition — what it
// renders, offers, refuses, and folds — in the console's code. Four things about this
// file are decisions rather than implementation, and each is load-bearing:
//
// 1. IT RENDERS, AND IT DOES NOT READ — AND `proposal-gate-reader.ts` IS THE ONE
//    CALLER. The state arrives as a prop and the acts leave as callbacks, exactly as
//    `ArtifactsPanel` takes its four arms; the reader beside this file is what holds
//    a worktree's gate state, routes all three growth operations — the branch-context
//    read, the preparation call, and the git action — and publishes the arm below.
//    All three are `gitflow-actions` slate rows and every one of them is refused by
//    the live bridge, which is why the reader's ordinary arm is `not-checked`: the
//    split is what keeps that refusal a rendered sentence rather than an effect
//    inside a component that also draws it.
//
//    WHAT THE READER CANNOT PUBLISH, AND WHY THAT IS STATED HERE. Two arms need
//    members no registered reply carries — `hosting-unavailable` needs a bundle path
//    and a preparation state naming it, and neither exists on a reply whose state
//    vocabulary is `draft | ready`. So the reader never publishes that arm, the gate
//    still draws it for a caller that can state it, and nothing here invents the
//    difference. `proposal-gate-state.ts` carries the same note beside the arm itself.
//
// 2. NOTHING HERE DECIDES WHO MAY ACT. `docs/architecture/contracts/error-contracts.md`
//    registers no `gitflow` namespace, so a failed action arrives as an ordinary
//    unsuccessful result and renders as a first-class failure carrying the daemon's own
//    message text. Controls are offered; the refusal renders beside the one pressed.
//    Greying a control out would mean holding a second copy of the daemon's rule.
//
//    WHICH ACTS EXIST IS A DIFFERENT QUESTION, and this file does not answer that one
//    either: `offeredProposalActions` in `proposal-actions.ts` does, and the act row
//    group this file composes — `proposal-gate-acts/`, which owns the pending
//    confirmation and is the only part of the gate holding any state — is handed that
//    list rather than the vocabulary. So the one condition that withholds an act here —
//    the preparation gate — is a rule stated once, beside the acts it governs, and
//    tested without rendering anything.
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
// THE PREPARATION GATE IS THE ORDER OF THIS FILE AND THE CONTENT OF ITS ACT ROW.
// `prepare-proposal` is offered before `push`, the prepared proposal is rendered above
// the acts, and the remote-mutating act sits under the thing it would send — and where
// there is no prepared proposal it is not offered at all, so the send cannot be
// confirmed against a payload that has never been on screen. A layout that put the
// button above the payload would invite approval of something not yet drawn; a row that
// offered it with no payload at all would invite approval of something not yet built.

import { useId } from "react";

import {
  Chip,
  DerivedFigure,
  Glyph,
  Nothing,
  WireFigure,
  formatCount,
} from "../primitives/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import { BranchContextSummary } from "./BranchContextSummary.js";
import { ProposalActionGroup, proposalConfirmationScope } from "./proposal-gate-acts/index.js";
import { ProposalSummary } from "./ProposalSummary.js";
import type { CheckoutConflict } from "./checkout-conflict.js";
import {
  CHANGE_REQUEST_STATE_PRESENTATION,
  CHECK_STATUS_PRESENTATION,
  MERGEABILITY_PRESENTATION,
  NO_REVIEW_DECISION_COPY,
  REVIEW_DECISION_PRESENTATION,
  checkRollup,
  type ProposalStatusReading,
} from "./hosting-status.js";
import { ONE_CUMULATIVE_PROPOSAL_COPY } from "./prepared-proposal.js";
import {
  offeredProposalActions,
  withheldRemoteActionCopy,
  type ProposalAction,
} from "./proposal-actions.js";
import {
  ACTION_FAILURE_COPY,
  HOSTING_UNAVAILABLE_COPY,
  type ProposalGateState,
} from "./proposal-gate-state.js";

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
  /** Send one modelled action. The one entry point, whichever acts the arm offers. */
  readonly onRequestAction?: ((action: ProposalAction) => void) | undefined;
  /** What the last action produced, keyed by the action that produced it. */
  readonly actionRefusals?: ReadonlyMap<ProposalAction, ConsoleRefusal> | undefined;
  /**
   * The act the holder is waiting on the bridge for.
   *
   * NOT AN ELIGIBILITY DERIVATION, on `isBlocked`'s terms: it is a fact about this
   * surface's own outstanding request, not a second copy of a daemon rule. The holder
   * refuses a second request whatever this component draws; holding the controls is
   * what stops a participant issuing one and being told off for it.
   */
  readonly inFlightAction?: ProposalAction | undefined;
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
        {props.state.kind === "prepared" && props.state.detectedHost !== undefined ? (
          // The detected host, in the host's own word. The provider is
          // auto-detected from the git remote URL, so this is a REPORT and never a
          // picker — there is no control here that could change it. Absent where
          // nothing supplied one, rather than shown as a guessed provider name: no
          // registered reply carries the detection result today.
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
  const offeredActions = offeredProposalActions(state);
  if (state.kind === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No branch context has been read."
        detail="The branch-context read reaches the daemon through the growth port and that wire is not registered, so the question could not be put. This is an unanswered question rather than a workspace without a context, and the port's own refusal sentence is beside the gate."
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
      <ProposalActionGroup
        actions={offeredActions}
        // What a confirmation opened here would be approving, as one value. Composed
        // from the arm rather than held by the group, because the group is handed a
        // list of acts and never sees the proposal those acts would send.
        confirmationScope={proposalConfirmationScope(offeredActions, state.proposal)}
        withheldReason={withheldRemoteActionCopy(state)}
        onRequestAction={props.onRequestAction}
        actionRefusals={props.actionRefusals}
        inFlightAction={props.inFlightAction}
        isBlocked={props.checkoutConflict !== undefined}
      />
    </div>
  );
}

/**
 * The three trichotomies, always visible, because they are the decision.
 *
 * The check rollup opens as counts rather than as a list: this gate's density puts
 * the rollup on the face and the full list one click away, on `Spec-023 §Meridian, the
 * design language` rule 7 ("secondary controls live one click away").
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
