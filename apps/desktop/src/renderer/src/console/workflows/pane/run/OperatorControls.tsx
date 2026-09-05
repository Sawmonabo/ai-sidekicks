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
// AND THAT REFUSAL IS OUTSIDE THE DISCLOSURE, WHICH IS THE POINT OF IT. It used to
// live beside the field it is about, inside the collapsible region — so an operator
// who typed a long reason, collapsed the disclosure, and pressed Cancel got a button
// that did nothing and no visible word about why. A refusal a person cannot see is
// indistinguishable from a control that is broken, which is the one failure rule 9
// exists to prevent. The refusal therefore stands in the control's own body where the
// button is, and the rejected submission ALSO opens the disclosure and puts the
// operator back on the field they have to shorten: one says what happened, the other
// says where to fix it, and neither substitutes for the other.
//
// ONE COMPONENT, TWO RENDERERS. The controls share the region, the reason state and
// the re-pin selection, and splitting them into sibling components would mean
// lifting all three into a parent that then renders nothing else. The two render
// functions below take exactly what they need, which is the idiom `WorkflowStateStrip`
// established for a switch that must stay total.
//
// AND BOTH OF THOSE ARE ANSWERS ABOUT ONE RUN. A typed cancellation reason and a
// chosen re-pin target are the operator's answers about the run in front of them, and
// the pane holding this component is RETARGETED IN PLACE — the deck rewrites its
// address and hands the same instance another run. Held for the mount, the reason
// carried over as a sentence about a run it was never written about, and the re-pin
// carried a version id that is in the new run's chain nowhere: the picker fell back to
// displaying its first option while the state kept run A's id, so pressing Resume sent
// run B a target the operator had never seen. Both are therefore held against the same
// `(growth, workflowRunId)` pair the pane's own read is addressed at, so the render
// that re-addresses already reads an empty field and no target.

import { useId, useMemo, useRef } from "react";

import type { GrowthPort } from "../../../bridge/index.js";
import {
  DerivedFigure,
  Glyph,
  InlineRefusal,
  WireFigure,
  formatByteQuantity,
} from "../../../primitives/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import { GLYPH_SIZE_CHROME } from "../../../tokens/index.js";
import {
  cancelReasonBudget,
  reasonPastBoundRefusal,
  type WorkflowCancelControl,
  type WorkflowResumeControl,
} from "./run-controls.js";

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
  /**
   * The port the pane's run read is addressed at, taken as a SUBJECT and not called.
   *
   * This component issues no read — the controls arrive already admitted or refused —
   * so the port is here for its identity alone. It is in the pair for the read's own
   * reason: the fixture's scenario switch replaces the bridge and keeps the run id, so
   * a run-only holder would carry a reason typed against the previous daemon into the
   * next one.
   */
  readonly growth: GrowthPort;
  /** The run whose controls these are, and which the fields below are answers about. */
  readonly workflowRunId: string;
}

/** The run's two controls, each offered or refused exactly as its caller said. */
export function OperatorControls(props: OperatorControlsProps): React.JSX.Element {
  const { growth, workflowRunId } = props;
  const { value: reason, publish: setReason } = useSubjectScopedState<string>(
    growth,
    workflowRunId,
    () => "",
  );
  const { value: repinTarget, publish: setRepinTarget } = useSubjectScopedState<string>(
    growth,
    workflowRunId,
    () => NO_REPIN,
  );
  const reasonFieldId = useId();
  const repinFieldId = useId();
  // Refs rather than a controlled `open`, deliberately. The disclosure below is the
  // platform's own and stays that way: a `open` prop with the state to back it would
  // be this file inventing the toggle its header says it does not have, and the
  // operator's own opening and closing would then be a race with React. A rejected
  // submission reaches past that and opens it, which is the one moment the console
  // has something to say about which region the operator should be looking at.
  const reasonDisclosure = useRef<HTMLDetailsElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
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
        reasonDisclosure,
        reasonField,
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
  /** The disclosure a rejected submission opens, so the offending field is in view. */
  readonly reasonDisclosure: React.RefObject<HTMLDetailsElement | null>;
  /** The field that submission is about, so the operator lands on what to shorten. */
  readonly reasonField: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * Puts the operator back on the field a refused submission is about.
 *
 * Opening is a direct write on the element rather than a state change for the reason
 * given at the refs: the disclosure belongs to the platform, and this is a nudge on
 * it rather than ownership of it. Focus moves with it because "in view" is a claim
 * about a sighted reader only — an operator driving this by keyboard is told which
 * field the refusal names by being placed in it, and nothing else here would say so.
 *
 * Both steps are conditional on the element existing rather than asserted: this runs
 * from an event handler, and a handler that threw on a torn-down form would turn a
 * refused cancellation into a crashed pane.
 */
function revealReasonField(fields: CancelFieldState): void {
  const disclosure = fields.reasonDisclosure.current;
  if (disclosure !== null) {
    disclosure.open = true;
  }
  fields.reasonField.current?.focus();
}

/**
 * Cancel, with its optional reason one disclosure away.
 *
 * The reason is behind a `<details>` because rule 7 puts the secondary thing one
 * click away and because cancelling without a reason is the common act — a field
 * always open would make the empty case look unfinished. `<details>` is the
 * platform's own disclosure, so it is keyboard-reachable and announced without this
 * file inventing a toggle.
 *
 * THE REFUSAL IS NOT BEHIND IT. Rule 7 puts the secondary CONTROL one click away; a
 * refusal is not secondary and is not a control, and hiding one behind a disclosure
 * the operator has already closed is how this button came to look broken. The live
 * budget stays inside, because it is only legible while the field it counts is.
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
        // A reason past the bound does not travel. The refusal explaining why is on
        // screen OUTSIDE the disclosure and stays there, and this press additionally
        // opens the disclosure onto the field it names — so a refused act is visibly
        // refused however the operator had arranged the form, which is the whole
        // difference between this and a button that appears to do nothing. It is why
        // the button is never disabled either: rule 9 keeps the control beside its
        // refusal rather than removing it.
        if (pastBound) {
          revealReasonField(fields);
          return;
        }
        control.cancel(fields.reason === "" ? undefined : fields.reason);
      }}
    >
      <div className="meridian-run-controls__head">
        <button type="submit" className="meridian-run-controls__action">
          <Glyph name="stop" size={GLYPH_SIZE_CHROME} />
          Cancel this run
        </button>
        <span className="meridian-run-controls__note">
          Cancelling is never queued and never waits on a provider window.
        </span>
      </div>
      {pastBound ? <InlineRefusal {...reasonPastBoundRefusal(fields.budget)} /> : null}
      <details className="meridian-run-controls__disclosure" ref={fields.reasonDisclosure}>
        <summary className="meridian-run-controls__summary">Add a reason (optional)</summary>
        <label className="meridian-run-controls__field-label" htmlFor={fields.reasonFieldId}>
          Reason
        </label>
        <textarea
          id={fields.reasonFieldId}
          ref={fields.reasonField}
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
          <Glyph name="play" size={GLYPH_SIZE_CHROME} />
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
