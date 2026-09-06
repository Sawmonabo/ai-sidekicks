// Composing the two controls that carry a body: steer, and the rewind composite.
//
// THIS COMPONENT'S OWN RULE, because no committed document states it: **preview is
// consent.** The scope of the rewind — which turns and which run position — is
// shown before the confirm, on every rewind without exception. So a rewind is never
// a button that fires — it is a target position, a
// preview of what that position means for this run, and then a confirm.
//
// WHAT THE PREVIEW CAN HONESTLY SHOW. The scope's turn-by-turn half belongs to the
// timeline, which this pane does not hold; what this pane holds is the run's own
// figures — the position asked for, the run version the guard will carry, and the
// state the run is in. Those are shown, and the sentence beside them says what a
// confirmed rewind does: the run lands `paused` at the confirmed position and
// nothing resumes on its own.
//
// THREE REFUSALS THIS SURFACE RAISES BEFORE THE WIRE.
//
//   • A rewind with no target position. The cut is daemon-supplied and this pane
//     computes none, on `Spec-023 §Rules every console surface obeys`' rule that
//     "eligibility is never projected by the renderer" — so an unnamed position is a
//     refusal here rather than a request the daemon has to reject.
//   • A rewind whose target is not a position. The field's whole trimmed value is
//     read through `rewind-position.ts`, so a typed suffix is refused rather than
//     truncated into the position it happens to start with — a prefix parse turns
//     `4oops` into a destructive rollback to 4 that the daemon cannot tell from one
//     somebody meant.
//   • A composite whose replacement is empty. "Never offers an unchanged resend as
//     a rewind: a no-op composite is refused at the affordance rather than
//     destroying a tail for nothing." Empty text is the reachable form of that at a
//     surface with no original body to compare against.
//
// The four STRUCTURAL guards — no active turn, no pending send, a participant-
// authored boundary, a resumable target — are the daemon's, each fail-closed at
// admission, and each arrives here as a typed rejection carrying its own reason.
// This file refuses none of them and would be wrong to try.
//
// THE FORM IS KEYED BY WHAT IT IS COMPOSING AGAINST, AND DEFENDS THAT FROM INSIDE.
// One `RunInterventionComposer` element used to be reused across a change of target:
// press Steer on run A, type, then press Rewind on run B while the form is open, and
// React re-rendered the same instance with a new `run` prop while the body, the
// target position, the refusal, and the pending dispatch all survived. Confirming
// then sent text authored for A to B, or left B waiting on A's settlement. The pane
// keys the element by `<runId>:<control>` so a change of identity remounts it, and
// this file holds the same rule a second time — the identity travels ON the pending
// dispatch, so a settlement raised under one identity is never read under another.
// A caller that drops the key cannot silently reintroduce the leak.
//
// AND THE SECOND HALF IS A HOLDER RATHER THAN AN EFFECT. The reset used to be a ref
// compared in a passive effect, which is one commit late by construction: on the
// render that first saw a new run, the body, the target position, the local refusal
// and the pending dispatch were still the PREVIOUS run's, nothing disabled the form
// for that commit, and a submit in it dispatched text authored for one run against
// another's comparand. An effect cannot be the reset for a value read during the
// render that changed the identity. The whole form is therefore held in one
// `useSubjectScopedState(bridge, composedIdentity, …)`, which re-seeds DURING that
// render — so the pass that first sees a new target already reads that target's own
// empty form, and the one-way close flag is re-seeded with it rather than surviving
// as a ref that would keep the next target's landed settlement from closing at all.
//
// AND IT WAITS ON ITS OWN DISPATCH AND NO OTHER. The form used to mark itself
// pending BEFORE calling `surface.dispatch`, and identify its settlement as
// "whichever record for this run and control is newer than the one held at dispatch
// time". Both halves failed together on one reachable sequence: cancel the form with
// its request still in flight, reopen the same run and control, type a new body,
// confirm. The surface's latch was still held, so the call was dropped — and the OLD
// request's settlement, landing afterwards, differed from the new form's baseline
// and was read as the new body's. An old success then closed the form and discarded
// text that never went anywhere.
//
// So the surface answers, and the form records nothing until it does. An admitted
// dispatch carries the token its settlement will be recorded under and the form
// reads the record by that token, which is exact rather than newest-wins. A refused
// one renders as what it is — an earlier request for this run is still settling —
// with the body kept and the confirm live, so the participant confirms again when
// the first one lands rather than losing what they typed.
//
// THE COMPOSER OUTLIVES ITS DISPATCH. It used to close the moment a dispatch was
// STARTED, which threw away the participant's body on every arm that did not land:
// a composite refused before the intervention was created, a transport rejection, a
// daemon `rejected`. The surface record keeps the refusal and nothing keeps the
// text, so the one thing the participant cannot reproduce was the one thing that
// was dropped. So the settlement is read — off `RunControlSurface.records`, which is
// where the dispatcher's own answer lands — and only a settlement that LANDED
// (`applied` or `degraded`, both of which the run's intervention history then
// renders) closes this form. Everything else keeps the body on screen beside the
// daemon's own code.

import { useCallback, useEffect, useId, useMemo } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { InlineRefusal } from "../../../primitives/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import { admissionRefusal, readComposerSettlement } from "./composer-settlement.js";
import type { ComposerSettlement } from "./composer-settlement.js";
import { parseRewindPosition } from "../controls/rewind-position.js";
import {
  RUN_CONTROL_REFUSAL_ORIGIN,
  type RollbackRequest,
  type RunControlDispatcher,
  type RunControlOutcome,
} from "../controls/run-control-dispatch.js";
import type { RunControlSurface } from "../controls/run-control-surface.js";
import type { RunProjection } from "../run-state-projection.js";

/** Which of the two body-carrying controls is being composed. */
export type ComposedControl = "steer" | "rollback";

export interface RunInterventionComposerProps {
  /**
   * The transport this form's state belongs to, and the surface's own subject.
   *
   * Present for the holder and for nothing else: this component makes no call of its
   * own — `surface.dispatch` does — but its state is about one transport and one
   * target, and a replacement retires both.
   */
  readonly bridge: ConsoleBridge;
  readonly run: RunProjection;
  readonly control: ComposedControl;
  readonly surface: RunControlSurface;
  /** Close the composer. Raised on cancel, and on a settlement that landed. */
  readonly onDismiss: () => void;
}

/** The dispatch this form is waiting on, named by the token the surface admitted. */
interface PendingDispatch {
  /** The token this form's own settlement will be recorded under. */
  readonly dispatchToken: string;
  /**
   * The run and control this dispatch was raised for.
   *
   * Carried on the dispatch rather than compared against the props alone, so the
   * one render between a target change and the reset effect below cannot read a
   * settlement raised for the previous target as this one's.
   */
  readonly composedIdentity: string;
}

/** What this form is composing against: one run, through one of the two controls. */
function composedIdentityFor(runId: string, control: ComposedControl): string {
  return `${runId}:${control}`;
}

/**
 * Everything this form holds about ONE target, in one value.
 *
 * One record rather than five hooks because they are reset by one fact — the target
 * changed — and five holders would be five chances for one of them to be forgotten,
 * which is exactly what the ref-and-effect reset was.
 */
interface ComposedForm {
  readonly body: string;
  readonly targetPosition: string;
  readonly localRefusal: ConsoleRefusal | undefined;
  readonly pendingDispatch: PendingDispatch | undefined;
  /**
   * Whether this form has already asked to be closed.
   *
   * Closing is one-way. The ledger this settlement is read from goes on changing —
   * another run's dispatch appends to it — so a form that asked to be closed on every
   * pass that recomputed its settlement would keep asking a parent that had already
   * stopped rendering it. Held here rather than in a ref so a new target starts able
   * to close again.
   */
  readonly hasAskedToClose: boolean;
}

const EMPTY_FORM: ComposedForm = Object.freeze({
  body: "",
  targetPosition: "",
  localRefusal: undefined,
  pendingDispatch: undefined,
  hasAskedToClose: false,
});

export function RunInterventionComposer(props: RunInterventionComposerProps): React.JSX.Element {
  const { bridge, run, control, surface, onDismiss } = props;
  const bodyId = useId();
  const positionId = useId();
  const comparand = surface.dispatcher.comparandFor(run.runId, run.runVersion);
  const composedIdentity = composedIdentityFor(run.runId, control);
  const { value: form, publish: publishForm } = useSubjectScopedState<ComposedForm>(
    bridge,
    composedIdentity,
    () => EMPTY_FORM,
  );
  const { body, targetPosition, localRefusal, pendingDispatch } = form;

  const publishBody = useCallback(
    (next: string) => {
      publishForm((held) => ({ ...held, body: next }));
    },
    [publishForm],
  );
  const publishTargetPosition = useCallback(
    (next: string) => {
      publishForm((held) => ({ ...held, targetPosition: next }));
    },
    [publishForm],
  );
  const publishLocalRefusal = useCallback(
    (next: ConsoleRefusal) => {
      publishForm((held) => ({ ...held, localRefusal: next }));
    },
    [publishForm],
  );

  // The dispatcher's answer, read off the record the surface appended for THIS
  // dispatch. The token is what makes that exact: it is minted at admission and is
  // the record's own id, so a record carrying another token is another request's
  // settlement and this form is still waiting.
  const settlement = useMemo((): ComposerSettlement | undefined => {
    if (pendingDispatch === undefined || pendingDispatch.composedIdentity !== composedIdentity) {
      return undefined;
    }
    const own = surface.records.find((record) => record.recordId === pendingDispatch.dispatchToken);
    // The record's own `composite` flag travels WITH its outcome, because the answer
    // cannot supply it: a rollback response echoes `replacementSend` nowhere, so the
    // settlement alone cannot tell a composite from a bare rewind — and the guard
    // reading below is the composite's, whose remedies name acts a bare rollback or a
    // rejected steer never asked anyone to perform.
    return own === undefined ? undefined : readComposerSettlement(own.outcome, own.composite);
  }, [pendingDispatch, surface.records, composedIdentity]);

  const isSending = pendingDispatch !== undefined && settlement === undefined;
  const isConfirmLatched = isSending || settlement?.kind === "recorded";

  const hasAskedToClose = form.hasAskedToClose;
  useEffect(() => {
    if (settlement?.kind === "landed" && !hasAskedToClose) {
      publishForm((held) => ({ ...held, hasAskedToClose: true }));
      onDismiss();
    }
  }, [settlement, hasAskedToClose, publishForm, onDismiss]);

  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isConfirmLatched) {
        // A latched confirm is still reachable by pressing Enter in a field, and a
        // second dispatch of one body is a second intervention.
        return;
      }
      // Dispatch first, then record — and record nothing at all unless the surface
      // admitted the call. The old order marked the form pending and then found out
      // whether anything had been sent.
      const dispatch = (
        perform: (dispatcher: RunControlDispatcher) => Promise<RunControlOutcome>,
        composite: boolean,
      ): void => {
        const admission = surface.dispatch(run.runId, control, perform, { composite });
        if (!admission.admitted) {
          publishForm((held) => ({ ...held, localRefusal: admissionRefusal(admission.reason) }));
          return;
        }
        publishForm((held) => ({
          ...held,
          localRefusal: undefined,
          pendingDispatch: { dispatchToken: admission.dispatchToken, composedIdentity },
        }));
      };
      if (control === "steer") {
        if (body.trim().length === 0) {
          publishLocalRefusal(
            refuse(
              RUN_CONTROL_REFUSAL_ORIGIN,
              "empty-directive",
              "There is nothing to steer with yet. Type what the run should do differently.",
            ),
          );
          return;
        }
        const steer = (dispatcher: RunControlDispatcher): Promise<RunControlOutcome> =>
          dispatcher.steer({ runId: run.runId, expectedRunVersion: comparand }, { content: body });
        dispatch(steer, false);
        return;
      }
      const reading = parseRewindPosition(targetPosition);
      if (reading.status !== "named") {
        publishLocalRefusal(
          reading.status === "unnamed"
            ? refuse(
                RUN_CONTROL_REFUSAL_ORIGIN,
                "target-position-unnamed",
                "A rewind needs the turn-boundary position it should land at. The console does not compute one — the position comes from the run's own recorded boundaries.",
              )
            : refuse(
                RUN_CONTROL_REFUSAL_ORIGIN,
                "target-position-unreadable",
                "A turn-boundary position is a whole number, and this field holds something else. Nothing was sent: the run's own recorded boundaries are where the position comes from.",
              ),
        );
        return;
      }
      // A test, never a transform: what the daemon is handed below is the body the
      // participant typed, byte for byte. A trimmed replacement would reach the
      // queue having lost the indentation or the separating blank line that was the
      // point of writing it that way.
      const isReplacementBlank = body.trim().length === 0;
      if (body.length > 0 && isReplacementBlank) {
        publishLocalRefusal(
          refuse(
            RUN_CONTROL_REFUSAL_ORIGIN,
            "empty-replacement",
            "A replacement message has to say something. Clear the field to rewind without one, or type the message that should take its place.",
          ),
        );
        return;
      }
      // Composed once and read twice, so the flag the record carries is derived from
      // the request actually sent rather than from a second `isReplacementBlank` test.
      const rollbackRequest: RollbackRequest = isReplacementBlank
        ? { targetPosition: reading.position }
        : { targetPosition: reading.position, replacementSend: { content: body } };
      const rollback = (dispatcher: RunControlDispatcher): Promise<RunControlOutcome> =>
        dispatcher.rollback({ runId: run.runId, expectedRunVersion: comparand }, rollbackRequest);
      dispatch(rollback, rollbackRequest.replacementSend !== undefined);
    },
    [
      control,
      body,
      targetPosition,
      surface,
      run.runId,
      comparand,
      isConfirmLatched,
      composedIdentity,
      publishForm,
      publishLocalRefusal,
    ],
  );

  return (
    <form className="meridian-run-composer" onSubmit={onSubmit}>
      <h4 className="meridian-run-composer__title">
        {control === "steer" ? "Steer this run" : "Rewind this run"}
      </h4>
      {control === "rollback" ? (
        <>
          <label className="meridian-run-composer__label" htmlFor={positionId}>
            Turn-boundary position to land at
          </label>
          <input
            id={positionId}
            className="meridian-run-composer__position"
            type="text"
            inputMode="numeric"
            value={targetPosition}
            onChange={(event) => {
              publishTargetPosition(event.target.value);
            }}
          />
          <p className="meridian-run-composer__preview">
            A confirmed rewind leaves run {run.runId} paused at the confirmed position, guarded
            against run version {String(comparand)}. Nothing resumes on its own, no delivered row is
            removed, and rewound turns stay in the timeline marked as superseded.
          </p>
        </>
      ) : null}
      <label className="meridian-run-composer__label" htmlFor={bodyId}>
        {control === "steer" ? "What should it do differently" : "Replacement message (optional)"}
      </label>
      <textarea
        id={bodyId}
        className="meridian-run-composer__body"
        value={body}
        rows={3}
        onChange={(event) => {
          publishBody(event.target.value);
        }}
      />
      {control === "rollback" && body.trim().length > 0 ? (
        <p className="meridian-run-composer__composite">
          This sends the rewind and the replacement as one intervention. The replacement is queued
          against the run and sends on the next resume; it is not dispatched by the rewind.
        </p>
      ) : null}
      {localRefusal === undefined ? null : (
        <InlineRefusal code={localRefusal.code} detail={localRefusal.detail} />
      )}
      {settlement === undefined || settlement.kind === "landed" ? null : (
        <InlineRefusal code={settlement.notice.code} detail={settlement.notice.detail} />
      )}
      <div className="meridian-run-composer__actions">
        <button
          type="submit"
          className="meridian-run-composer__confirm"
          disabled={isConfirmLatched}
          aria-busy={isSending}
        >
          {control === "steer" ? "Send steer" : "Confirm rewind"}
        </button>
        <button type="button" className="meridian-run-composer__dismiss" onClick={onDismiss}>
          Cancel
        </button>
      </div>
    </form>
  );
}
