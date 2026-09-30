// The two run controls, as a projection of what the daemon admitted. Structural rules:
//
//   1. Cancel is never gated, queued, delayed or disabled: the button carries no `disabled`
//      attribute on any path, so a widened condition cannot add the gate back.
//   2. Resume never waits for an armed `autoResumeAt`; this component never reads one.
//   3. The re-pin is explicit or absent. There is no "latest" option, because a server-resolved
//      latest would race the definition's edits and leave the audited from-and-to pair
//      unverifiable. An empty chain means no picker is drawn, not a disabled one.
//   4. Eligibility is the daemon's. Both controls are always offered; the press puts the
//      question and the answer (a settlement, or a refusal from the controls' own single flight
//      or reason bound) renders inline beside the button via `RunControlOutcome.tsx`.
//
// The call, its single flight and the reply are `hooks/useRunControlDispatch.ts`; this file is
// the form. It holds no single-flight flag: a flag read in a handler is the value from the
// render that produced it, so two presses in one frame would become two cancellations.
//
// The reason is measured before the round trip and never silently truncated. A reason past the
// bound raises a refusal that stands outside the collapsible region (a refusal hidden behind a
// closed disclosure reads as a broken button), and the rejected submission also opens the
// disclosure and focuses the field to shorten.
//
// The reason and the re-pin target are answers about one run, and the pane is re-addressed in
// place, so both are held against the run id: the render that re-addresses reads an empty
// field and no target. The held re-pin id is also resolved against the chain on screen each
// render, since a version published while the pane stood open can drop the chosen id and leave
// the `<select>` blank while the submit still sends it (`useHumanFormSelection.ts` does the same
// for its phase id).

import "./OperatorControls.css";

import { useId, useMemo, useRef } from "react";

import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatByteQuantity } from "@renderer/lib/wire-figures.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { GLYPH_SIZE_CHROME } from "@renderer/styles/glyphs.js";
import { RunControlOutcome } from "./RunControlOutcome.js";
import {
  cancelReasonBudget,
  reasonPastBoundRefusal,
  type WorkflowCancelControl,
  type WorkflowResumeControl,
  type WorkflowVersionChoice,
} from "../run-controls.js";

/**
 * The subject the typed reason and the chosen re-pin are held against, so the run id
 * alone re-addresses them.
 */
const CONTROL_FIELDS_SUBJECT = {};

/** The picker value that means "resume without re-pinning". Never a version id. */
const NO_REPIN = "";

/**
 * What the two run controls are drawn from: each control's press and outcome, and the run
 * the reason and re-pin fields are held against.
 */
export interface OperatorControlsProps {
  readonly cancel: WorkflowCancelControl;
  readonly resume: WorkflowResumeControl;
  /** The run whose controls these are, and which the fields below are answers about. */
  readonly workflowRunId: string;
}

/** The run's two controls, each offered or refused exactly as its caller said. */
export function OperatorControls(props: OperatorControlsProps): React.JSX.Element {
  const { workflowRunId } = props;
  const { value: reason, publish: setReason } = useSubjectScopedState<string>(
    CONTROL_FIELDS_SUBJECT,
    workflowRunId,
    () => "",
  );
  const { value: heldRepinTarget, publish: setRepinTarget } = useSubjectScopedState<string>(
    CONTROL_FIELDS_SUBJECT,
    workflowRunId,
    () => NO_REPIN,
  );
  // Resolved first so no arm can print, offer or submit a target the chain does not carry.
  const repinTarget = repinTargetWithinChain(heldRepinTarget, props.resume.versionChain);
  const reasonFieldId = useId();
  const repinFieldId = useId();
  // Refs, not a controlled `open`: the `<details>` stays the platform's own toggle, and a
  // rejected submission reaches past it to open it.
  const reasonDisclosure = useRef<HTMLDetailsElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  // Memoized because the reason is bounded in kibibytes and the encode runs over a large string.
  const budget = useMemo(() => cancelReasonBudget(reason), [reason]);

  return (
    <section className="meridian-workflow-run-controls" aria-label="Run controls">
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

/**
 * The held re-pin target, or no re-pin where the chain on screen does not offer it.
 *
 * The fallback is `NO_REPIN`, never the chain's first entry: that would choose a target the
 * operator never named. It takes the chain rather than the whole control so it cannot start
 * deciding eligibility from the outcome beside it.
 */
function repinTargetWithinChain(
  held: string,
  versionChain: readonly WorkflowVersionChoice[],
): string {
  return versionChain.some((choice) => choice.workflowVersionId === held) ? held : NO_REPIN;
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
 * Puts the operator back on the field a refused submission is about. Opening is a direct write
 * on the platform's element, and focus moves with it so a keyboard user lands on the field the
 * refusal names. Both steps tolerate a missing element because a throw here would turn a
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
 * Cancel, with its optional reason one disclosure away in a platform `<details>`, since
 * canceling without a reason is the common act. The refusal is not behind it (a closed
 * disclosure would hide it); the live budget stays inside, legible only with its field.
 */
function renderCancel(control: WorkflowCancelControl, fields: CancelFieldState): React.JSX.Element {
  const pastBound = fields.budget.isPastBound;
  return (
    <form
      className="meridian-workflow-run-controls__control"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        // A reason past the bound does not travel. The refusal stays outside the disclosure and
        // this press also opens it onto the field; the button is never disabled.
        if (pastBound) {
          revealReasonField(fields);
          return;
        }
        control.cancel(fields.reason === "" ? undefined : fields.reason);
      }}
    >
      <div className="meridian-workflow-run-controls__head">
        <button type="submit" className="meridian-workflow-run-controls__action">
          <Glyph name="stop" size={GLYPH_SIZE_CHROME} />
          Cancel this run
        </button>
        <span className="meridian-workflow-run-controls__note">
          Canceling is never queued and never waits on a provider window.
        </span>
      </div>
      {pastBound ? <InlineRefusal {...reasonPastBoundRefusal(fields.budget)} /> : null}
      {/*
        What the daemon said about the last press. Below the local refusal because they answer
        different moments: an operator just refused for a long reason must not read the previous
        round trip's answer as the response to this press.
      */}
      <RunControlOutcome outcome={control.outcome} />
      <details className="meridian-workflow-run-controls__disclosure" ref={fields.reasonDisclosure}>
        <summary className="meridian-workflow-run-controls__summary">
          Add a reason (optional)
        </summary>
        <label
          className="meridian-workflow-run-controls__field-label"
          htmlFor={fields.reasonFieldId}
        >
          Reason
        </label>
        <textarea
          id={fields.reasonFieldId}
          ref={fields.reasonField}
          className="meridian-workflow-run-controls__reason"
          rows={3}
          value={fields.reason}
          onChange={(changeEvent) => {
            fields.setReason(changeEvent.target.value);
          }}
        />
        <p className="meridian-workflow-run-controls__budget">
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
 * Resume, with the re-pin riding its optional member. A `suspended` answer is a legal outcome
 * (a still-spent account re-parks on the next dispatch), so the note says a press is no promise
 * the run will be running afterwards.
 */
function renderResume(control: WorkflowResumeControl, fields: RepinFieldState): React.JSX.Element {
  return (
    <form
      className="meridian-workflow-run-controls__control"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        control.resume(
          fields.repinTarget === NO_REPIN
            ? undefined
            : { targetWorkflowVersionId: fields.repinTarget },
        );
      }}
    >
      <div className="meridian-workflow-run-controls__head">
        <button type="submit" className="meridian-workflow-run-controls__action">
          <Glyph name="play" size={GLYPH_SIZE_CHROME} />
          Resume this run
        </button>
        <span className="meridian-workflow-run-controls__note">
          A run that re-parks on its next dispatch is an outcome and not a failure.
        </span>
      </div>
      <RunControlOutcome outcome={control.outcome} />
      {control.versionChain.length === 0 ? null : (
        <div className="meridian-workflow-run-controls__repin">
          <label
            className="meridian-workflow-run-controls__field-label"
            htmlFor={fields.repinFieldId}
          >
            Re-pin to a version
          </label>
          <select
            id={fields.repinFieldId}
            className="meridian-workflow-run-controls__select"
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
            <p className="meridian-workflow-run-controls__repin-target">
              <span>Resuming onto </span>
              <WireFigure value={fields.repinTarget} />
            </p>
          )}
        </div>
      )}
    </form>
  );
}
