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
// dispatch, so a settlement raised under one identity is never read under another,
// and an identity change clears the fields outright. A caller that drops the key
// cannot silently reintroduce the leak.
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

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { InlineRefusal } from "../../primitives/index.js";
import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { parseRewindPosition } from "./rewind-position.js";
import {
  RUN_CONTROL_REFUSAL_ORIGIN,
  type RunControlDispatcher,
  type RunControlOutcome,
} from "./run-control-dispatch.js";
import type { RunControlAdmissionRefusal, RunControlSurface } from "./run-control-surface.js";
import type { RunProjection } from "./run-state-feed.js";

/** Which of the two body-carrying controls is being composed. */
export type ComposedControl = "steer" | "rollback";

export interface RunInterventionComposerProps {
  readonly run: RunProjection;
  readonly control: ComposedControl;
  readonly surface: RunControlSurface;
  /** Close the composer. Raised on cancel, and on a settlement that landed. */
  readonly onDismiss: () => void;
}

/**
 * What one settled dispatch means to the form that raised it.
 *
 * Three arms rather than landed-or-not, because the two that keep the form open
 * offer different next moves: a refusal is retried by confirming again, while an
 * intervention the daemon has RECORDED and not yet applied would be a second
 * intervention if it were confirmed twice — so that arm latches the confirm and
 * leaves cancel as the way out.
 */
type ComposerSettlement =
  | { readonly kind: "landed" }
  | { readonly kind: "refused"; readonly notice: ConsoleRefusal }
  | { readonly kind: "recorded"; readonly notice: ConsoleRefusal };

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

export function RunInterventionComposer(props: RunInterventionComposerProps): React.JSX.Element {
  const { run, control, surface, onDismiss } = props;
  const [body, setBody] = useState("");
  const [targetPosition, setTargetPosition] = useState("");
  const [localRefusal, setLocalRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const [pendingDispatch, setPendingDispatch] = useState<PendingDispatch | undefined>(undefined);
  const bodyId = useId();
  const positionId = useId();
  const comparand = surface.dispatcher.comparandFor(run.runId, run.runVersion);
  const composedIdentity = composedIdentityFor(run.runId, control);

  // The dispatcher's answer, read off the record the surface appended for THIS
  // dispatch. The token is what makes that exact: it is minted at admission and is
  // the record's own id, so a record carrying another token is another request's
  // settlement and this form is still waiting.
  const settlement = useMemo((): ComposerSettlement | undefined => {
    if (pendingDispatch === undefined || pendingDispatch.composedIdentity !== composedIdentity) {
      return undefined;
    }
    const own = surface.records.find((record) => record.recordId === pendingDispatch.dispatchToken);
    return own === undefined ? undefined : readComposerSettlement(own.outcome);
  }, [pendingDispatch, surface.records, composedIdentity]);

  const isSending = pendingDispatch !== undefined && settlement === undefined;
  const isConfirmLatched = isSending || settlement?.kind === "recorded";

  // Closing is one-way. The ledger this settlement is read from goes on changing —
  // another run's dispatch appends to it — so a form that asked to be closed on
  // every pass that recomputed its settlement would keep asking a parent that had
  // already stopped rendering it.
  const hasAskedToClose = useRef(false);

  // The second half of the reset, for a caller that renders this form without the
  // key the pane gives it. Held against the identity the last commit rendered rather
  // than fired on every pass, so a mount clears nothing and only an actual change of
  // target does — a `setState` on every render would be a loop.
  const renderedIdentity = useRef(composedIdentity);
  useEffect(() => {
    if (renderedIdentity.current === composedIdentity) {
      return;
    }
    renderedIdentity.current = composedIdentity;
    setBody("");
    setTargetPosition("");
    setLocalRefusal(undefined);
    setPendingDispatch(undefined);
    hasAskedToClose.current = false;
  }, [composedIdentity]);

  useEffect(() => {
    if (settlement?.kind === "landed" && !hasAskedToClose.current) {
      hasAskedToClose.current = true;
      onDismiss();
    }
  }, [settlement, onDismiss]);

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
      ): void => {
        const admission = surface.dispatch(run.runId, control, perform);
        if (!admission.admitted) {
          setLocalRefusal(admissionRefusal(admission.reason));
          return;
        }
        setLocalRefusal(undefined);
        setPendingDispatch({ dispatchToken: admission.dispatchToken, composedIdentity });
      };
      if (control === "steer") {
        if (body.trim().length === 0) {
          setLocalRefusal(
            refuse(
              RUN_CONTROL_REFUSAL_ORIGIN,
              "empty-directive",
              "There is nothing to steer with yet. Type what the run should do differently.",
            ),
          );
          return;
        }
        dispatch((dispatcher) =>
          dispatcher.steer({ runId: run.runId, expectedRunVersion: comparand }, { content: body }),
        );
        return;
      }
      const reading = parseRewindPosition(targetPosition);
      if (reading.status !== "named") {
        setLocalRefusal(
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
        setLocalRefusal(
          refuse(
            RUN_CONTROL_REFUSAL_ORIGIN,
            "empty-replacement",
            "A replacement message has to say something. Clear the field to rewind without one, or type the message that should take its place.",
          ),
        );
        return;
      }
      dispatch((dispatcher) =>
        dispatcher.rollback(
          { runId: run.runId, expectedRunVersion: comparand },
          isReplacementBlank
            ? { targetPosition: reading.position }
            : { targetPosition: reading.position, replacementSend: { content: body } },
        ),
      );
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
              setTargetPosition(event.target.value);
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
          setBody(event.target.value);
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

/**
 * What a refused admission says, in this form's own words.
 *
 * Total over the closed refusal set, so a second reason fails to compile here rather
 * than reaching a participant as an empty sentence beside a form that did nothing.
 */
function admissionRefusal(reason: RunControlAdmissionRefusal): ConsoleRefusal {
  return refuse(RUN_CONTROL_REFUSAL_ORIGIN, reason, ADMISSION_REFUSAL_DETAIL[reason]);
}

const ADMISSION_REFUSAL_DETAIL: Readonly<Record<RunControlAdmissionRefusal, string>> = {
  "in-flight":
    "An earlier request for this run is still settling, so nothing was sent. What you typed is still here — confirm again once it lands.",
};

/**
 * Read one settled dispatch the way this form has to act on it.
 *
 * The daemon's own `state` decides, never the presence of a result: `applied` and
 * `degraded` are the two the intervention landed on, and a degraded settlement is a
 * real outcome the run's history renders in full — this form's job there is only to
 * get out of the way. Every other arm keeps the body, and the code a person sees is
 * the daemon's own: `rejectionReason` where the wire sent one, and the wire's state
 * otherwise. Nothing here paraphrases a wire code into console prose.
 */
function readComposerSettlement(outcome: RunControlOutcome): ComposerSettlement {
  if (outcome.kind === "refused") {
    return { kind: "refused", notice: outcome.refusal };
  }
  if (outcome.kind === "acknowledged") {
    // Pause and resume alone answer with an acknowledgment, and this form composes
    // neither. Reached only if that ever changes, and landing is the honest reading
    // of an acknowledgment.
    return { kind: "landed" };
  }
  const { response } = outcome;
  // Switched on a local rather than on `outcome.response.state` so the exhaustive
  // tail below still has a value to hand `unreadableSettlement`: narrowing the
  // RESPONSE to `never` would leave its `state` unreadable in that branch.
  const settledState = response.state;
  switch (settledState) {
    case "applied":
    case "degraded":
      return { kind: "landed" };
    case "rejected":
      return {
        kind: "refused",
        notice: refuse(
          RUN_CONTROL_REFUSAL_ORIGIN,
          response.rejectionReason ?? settledState,
          "The daemon did not apply this. What you typed is still here — change what it asks for and confirm again, or cancel to close without sending.",
        ),
      };
    case "expired":
      return {
        kind: "refused",
        notice: refuse(
          RUN_CONTROL_REFUSAL_ORIGIN,
          settledState,
          "This intervention expired before it was applied. What you typed is still here — confirm again to raise a new one, or cancel to close.",
        ),
      };
    case "requested":
    case "accepted":
      return {
        kind: "recorded",
        notice: refuse(
          RUN_CONTROL_REFUSAL_ORIGIN,
          settledState,
          "The daemon recorded this intervention and has not applied it yet. Your text is on that record; confirming again would raise a second one, so this control stays latched until you close it.",
        ),
      };
    default:
      return unreadableSettlement(settledState);
  }
}

/**
 * The `satisfies never` tail. A seventh intervention state fails to compile here
 * rather than falling through to a form that neither closes nor says why.
 */
function unreadableSettlement(state: never): ComposerSettlement {
  const unreadable = state satisfies never;
  return {
    kind: "refused",
    notice: refuse(
      RUN_CONTROL_REFUSAL_ORIGIN,
      String(unreadable),
      "The daemon answered with a state this console has no reading for, so nothing here claims the intervention landed. What you typed is still here.",
    ),
  };
}
