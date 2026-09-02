// The two run controls, as a projection of what the daemon admitted.
//
// FOUR RULES ARE STRUCTURAL HERE, NOT STYLISTIC. Each one is a thing this component
// is unable to do rather than a thing it chooses not to:
//
//   1. **Cancel is never gated, queued, delayed or disabled.** There is no draining
//      state, no wait on a provider window, and no confirmation step — a parked run
//      cancels exactly as a running one does. The button carries no `disabled`
//      attribute on any path, so no future edit can quietly add the gate back by
//      widening a condition.
//   2. **Resume never waits for an armed instant to elapse.** An `autoResumeAt` is
//      a schedule the engine armed, not a lock on the operator; this surface never
//      reads one, so it cannot come to depend on one.
//   3. **The re-pin is explicit or absent.** It rides resume's optional member and
//      names a target the operator chose from the chain. There is no "latest"
//      option, because a server-resolved latest would race the definition's own
//      edits and leave the audited from-and-to pair unverifiable against what the
//      operator saw. An empty chain means no target can be named, so the picker is
//      absent rather than empty — "absent, not disabled", the family's own rule.
//   4. **Eligibility is the daemon's.** A control arrives admitted or refused; this
//      file reads no run status and computes no permission. A refusal renders
//      INLINE (`Spec-023 §Console Design (Meridian)` rule 9: nothing changed, the
//      act did not happen, and the control stays beside its refusal).
//
// THE REASON BOUND IS MEASURED BEFORE THE ROUND TRIP AND NEVER SILENTLY TRUNCATED.
// The engine bounds a cancellation reason exactly as it bounds a park cause, and a
// console that quietly cut the operator's sentence at the bound would be editing
// their words. So the budget is visible while they type and a reason past it earns
// a refusal that says what to do — the loud failure the design asks for, raised
// before anyone's round trip is spent.
//
// ONE COMPONENT, TWO RENDERERS. The controls share the region, the reason state and
// the re-pin selection, and splitting them into sibling components would mean
// lifting all three into a parent that then renders nothing else. The two render
// functions below take exactly what they need, which is the idiom `WorkflowChrome`
// established for a switch that must stay total.

import { useId, useMemo, useState } from "react";

import {
  DerivedFigure,
  Glyph,
  InlineRefusal,
  WireFigure,
  formatByteQuantity,
} from "../../primitives/index.js";
import {
  cancelReasonBudget,
  reasonPastBoundRefusal,
  type WorkflowCancelControl,
  type WorkflowResumeControl,
} from "./run-controls.js";

/** Edge length of a control's glyph, matching the chrome header's scale. */
const CONTROL_GLYPH_SIZE = 14;

/** The picker value that means "resume without re-pinning". Never a version id. */
const NO_REPIN = "";

/**
 * The state a resume answers with when the run re-parks on its next dispatch.
 *
 * A wire value quoted in the note beside the button, so it wears rule 4's mono
 * signature: an operator who then sees this word on the run reads the same string
 * the console warned them about, not a paraphrase of it.
 */
const RE_PARKED_RUN_STATE = "suspended";

export interface OperatorControlsProps {
  readonly cancel: WorkflowCancelControl;
  readonly resume: WorkflowResumeControl;
}

/** The run's two controls, each offered or refused exactly as its caller said. */
export function OperatorControls(props: OperatorControlsProps): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [repinTarget, setRepinTarget] = useState(NO_REPIN);
  const reasonFieldId = useId();
  const repinFieldId = useId();
  // Memoised because the reason is bounded in KIBIBYTES, so the encode this runs is
  // over a genuinely large string on the last keystroke before the bound and would
  // otherwise repeat on every unrelated render of the pane around it.
  const budget = useMemo(() => cancelReasonBudget(reason), [reason]);

  return (
    <section className="meridian-run-controls" aria-label="Run controls">
      {renderCancel(props.cancel, {
        reason,
        setReason,
        reasonFieldId,
        budget,
      })}
      {renderResume(props.resume, { repinTarget, setRepinTarget, repinFieldId })}
    </section>
  );
}

/** Everything the cancel control needs beyond the control itself. */
interface CancelFieldState {
  readonly reason: string;
  readonly setReason: (next: string) => void;
  readonly reasonFieldId: string;
  readonly budget: ReturnType<typeof cancelReasonBudget>;
}

/**
 * Cancel, with its optional reason one disclosure away.
 *
 * The reason is behind a `<details>` because rule 7 puts the secondary thing one
 * click away and because cancelling without a reason is the common act — a field
 * always open would make the empty case look unfinished. `<details>` is the
 * platform's own disclosure, so it is keyboard-reachable and announced without this
 * file inventing a toggle.
 */
function renderCancel(control: WorkflowCancelControl, fields: CancelFieldState): React.JSX.Element {
  if (control.kind === "refused") {
    return (
      <div className="meridian-run-controls__control">
        <span className="meridian-run-controls__label">Cancel</span>
        <InlineRefusal code={control.refusal.code} detail={control.refusal.detail} />
      </div>
    );
  }
  const pastBound = fields.budget.isPastBound;
  return (
    <form
      className="meridian-run-controls__control"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        // A reason past the bound does not travel. The refusal explaining why is
        // already on screen and stays there — this is a refused act, not a silent
        // one, which is why the button above it is never disabled: rule 9 keeps the
        // control beside its refusal rather than removing it.
        if (pastBound) {
          return;
        }
        control.cancel(fields.reason === "" ? undefined : fields.reason);
      }}
    >
      <div className="meridian-run-controls__head">
        <button type="submit" className="meridian-run-controls__action">
          <Glyph name="stop" size={CONTROL_GLYPH_SIZE} />
          Cancel this run
        </button>
        <span className="meridian-run-controls__note">
          Cancelling is never queued and never waits on a provider window.
        </span>
      </div>
      <details className="meridian-run-controls__disclosure">
        <summary className="meridian-run-controls__summary">Add a reason (optional)</summary>
        <label className="meridian-run-controls__field-label" htmlFor={fields.reasonFieldId}>
          Reason
        </label>
        <textarea
          id={fields.reasonFieldId}
          className="meridian-run-controls__reason"
          rows={3}
          value={fields.reason}
          onChange={(changeEvent) => {
            fields.setReason(changeEvent.target.value);
          }}
        />
        <p className="meridian-run-controls__budget">
          <DerivedFigure text={formatByteQuantity(fields.budget.remainingBytes).text} />
          <span> of the reason budget left.</span>
        </p>
        {pastBound ? <InlineRefusal {...reasonPastBoundRefusal(fields.budget)} /> : null}
      </details>
    </form>
  );
}

/** Everything the resume control needs beyond the control itself. */
interface RepinFieldState {
  readonly repinTarget: string;
  readonly setRepinTarget: (next: string) => void;
  readonly repinFieldId: string;
}

/**
 * Resume, with the re-pin riding its optional member.
 *
 * A `suspended` answer is a legal outcome of this call rather than an error — a
 * still-spent account re-parks on the next dispatch — so nothing here treats the
 * press as a promise that the run will be running afterwards, and the note says so
 * where the operator is about to press it.
 */
function renderResume(control: WorkflowResumeControl, fields: RepinFieldState): React.JSX.Element {
  if (control.kind === "refused") {
    return (
      <div className="meridian-run-controls__control">
        <span className="meridian-run-controls__label">Resume</span>
        <InlineRefusal code={control.refusal.code} detail={control.refusal.detail} />
      </div>
    );
  }
  return (
    <form
      className="meridian-run-controls__control"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        control.resume(
          fields.repinTarget === NO_REPIN
            ? undefined
            : { targetWorkflowVersionId: fields.repinTarget },
        );
      }}
    >
      <div className="meridian-run-controls__head">
        <button type="submit" className="meridian-run-controls__action">
          <Glyph name="play" size={CONTROL_GLYPH_SIZE} />
          Resume this run
        </button>
        <span className="meridian-run-controls__note">
          <span>A run that re-parks on its next dispatch answers </span>
          <WireFigure value={RE_PARKED_RUN_STATE} />
          <span>, which is an outcome and not a failure.</span>
        </span>
      </div>
      {control.versionChain.length === 0 ? null : (
        <div className="meridian-run-controls__repin">
          <label className="meridian-run-controls__field-label" htmlFor={fields.repinFieldId}>
            Re-pin to a version
          </label>
          <select
            id={fields.repinFieldId}
            className="meridian-run-controls__select"
            value={fields.repinTarget}
            onChange={(changeEvent) => {
              fields.setRepinTarget(changeEvent.target.value);
            }}
          >
            <option value={NO_REPIN}>Keep the pinned version</option>
            {control.versionChain.map((choice) => (
              <option key={choice.workflowVersionId} value={choice.workflowVersionId}>
                {choice.isCurrentPin ? `${choice.label} (pinned now)` : choice.label}
              </option>
            ))}
          </select>
          {fields.repinTarget === NO_REPIN ? null : (
            <p className="meridian-run-controls__repin-target">
              <span>Resuming onto </span>
              <WireFigure value={fields.repinTarget} />
            </p>
          )}
        </div>
      )}
    </form>
  );
}
