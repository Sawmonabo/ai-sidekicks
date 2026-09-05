import { useId } from "react";
import { Glyph, Nothing, WireFigure } from "../../primitives/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { BranchContextSummary } from "../mounts/BranchContextSummary.js";
import { ProposalActionGroup, proposalConfirmationScope } from "./proposal-gate-acts/index.js";
import { ProposalSummary } from "./ProposalSummary.js";
import type { CheckoutConflict } from "./checkout-conflict.js";
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
import { StatusRollup } from "./StatusRollup.js";
import { CheckoutConflictChoice } from "./CheckoutConflictChoice.js";
import { GATE_GLYPH_SIZE } from "./proposal-gate-chrome.js";

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
