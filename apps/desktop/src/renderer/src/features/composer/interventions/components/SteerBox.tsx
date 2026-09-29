// The steer form: a body typed against one run, sent as a steer intervention.
//
// THE FORM IS KEYED BY WHAT IT IS COMPOSING AGAINST, AND DEFENDS THAT FROM INSIDE.
// One element reused across a change of run would keep the body, the refusal and the
// pending dispatch of the previous run, and confirming would send text authored for
// one run to another, or leave the new run waiting on the old one's settlement. The
// caller keys the element by run id so a change of run remounts it, and this file
// holds the same rule a second time — the run id travels ON the pending dispatch, so
// a settlement raised for one run is never read as another's.
//
// THE SECOND HALF IS A HOLDER RATHER THAN AN EFFECT. A reset done in a passive effect
// is one commit late by construction: on the render that first sees a new run the
// body, the local refusal and the pending dispatch would still be the previous run's,
// nothing would disable the form for that commit, and a submit in it would dispatch
// text authored for one run against another's comparand. The whole form is therefore
// held in one `useSubjectScopedState(bridge, run id, …)`, which re-seeds DURING that
// render, and the one-way close flag is re-seeded with it so the next run's landed
// settlement can still close the form.
//
// IT WAITS ON ITS OWN DISPATCH AND NO OTHER. The form records nothing until the
// dispatch state answers. An admitted dispatch carries the token its settlement will be
// recorded under and the form reads the record by that token, which is exact rather
// than newest-wins: cancel the form with its request in flight, reopen it, and the
// old request's settlement is not read as the new body's. A refused dispatch renders
// as what it is — an earlier request for this run is still settling — with the body
// kept and the confirm live, so the user confirms again once the first one lands.
//
// THE COMPOSER OUTLIVES ITS DISPATCH. The dispatch record keeps a refusal and nothing
// keeps the text, so the form does not close when a dispatch STARTS. The settlement is
// read off `RunControlDispatchState.records`, and only one that LANDED (`applied` or
// `degraded`) closes the form; everything else keeps the body on screen beside the
// daemon's own code.

import { useCallback, useEffect, useId, useMemo } from "react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import {
  RUN_INTERVENTION_REFUSAL_ORIGIN,
  admissionRefusal,
  readInterventionFormSettlement,
} from "../intervention-form-settlement.js";
import type { InterventionFormSettlement } from "../intervention-form-settlement.js";
import type { RunControlCommandRun } from "../../run-controls/contributions/run-control-commands.js";
import type {
  RunControlDispatcher,
  RunControlOutcome,
} from "../../run-controls/services/run-control-dispatch.js";
import type { RunControlDispatchState } from "../../run-controls/hooks/useRunControlDispatch.js";

import "./SteerBox.css";

/** What the steer form is given: the run it addresses and the dispatch state it goes through. */
export interface SteerBoxProps {
  /**
   * The transport this form's state belongs to, and the dispatch state's own subject.
   *
   * Present for the holder and for nothing else: this component makes no call of its
   * own — `dispatchState.dispatch` does — but its state is about one transport and one
   * run, and a replacement retires both.
   */
  readonly bridge: PlatformBridge;
  readonly run: RunControlCommandRun;
  readonly dispatchState: RunControlDispatchState;
  /** Close the composer. Raised on cancel, and on a settlement that landed. */
  readonly onDismiss: () => void;
}

/** The dispatch this form is waiting on, named by the token the dispatch state admitted. */
interface PendingDispatch {
  /** The token this form's own settlement will be recorded under. */
  readonly dispatchToken: string;
  /**
   * The run this dispatch was raised for.
   *
   * Carried on the dispatch rather than compared against the props alone, so the
   * one render between a run change and the reset cannot read a settlement raised
   * for the previous run as this one's.
   */
  readonly composedIdentity: string;
}

/**
 * Everything this form holds about ONE run, in one value.
 *
 * One record rather than several hooks because they are reset by one fact — the run
 * changed — and separate holders would be separate chances for one of them to be
 * forgotten.
 */
interface ComposedForm {
  readonly body: string;
  readonly localRefusal: Refusal | undefined;
  readonly pendingDispatch: PendingDispatch | undefined;
  /**
   * Whether this form has already asked to be closed.
   *
   * Closing is one-way. The ledger this settlement is read from goes on changing —
   * another run's dispatch appends to it — so a form that asked to be closed on every
   * pass that recomputed its settlement would keep asking a parent that had already
   * stopped rendering it. Held here rather than in a ref so a new run starts able
   * to close again.
   */
  readonly hasAskedToClose: boolean;
}

const EMPTY_FORM: ComposedForm = Object.freeze({
  body: "",
  localRefusal: undefined,
  pendingDispatch: undefined,
  hasAskedToClose: false,
});

/** The form that sends a steer to one run. */
export function SteerBox(props: SteerBoxProps): React.JSX.Element {
  const { bridge, run, dispatchState, onDismiss } = props;
  const bodyId = useId();
  const comparand = dispatchState.dispatcher.comparandFor(run.runId, run.runVersion);
  const composedIdentity = run.runId;
  const { value: form, publish: publishForm } = useSubjectScopedState<ComposedForm>(
    bridge,
    composedIdentity,
    () => EMPTY_FORM,
  );
  const { body, localRefusal, pendingDispatch } = form;

  const publishBody = useCallback(
    (next: string) => {
      publishForm((held) => ({ ...held, body: next }));
    },
    [publishForm],
  );

  // The dispatcher's answer, read off the record the dispatch state appended for THIS
  // dispatch. The token is what makes that exact: it is minted at admission and is
  // the record's own id, so a record carrying another token is another request's
  // settlement and this form is still waiting.
  const settlement = useMemo((): InterventionFormSettlement | undefined => {
    if (pendingDispatch === undefined || pendingDispatch.composedIdentity !== composedIdentity) {
      return undefined;
    }
    const own = dispatchState.records.find(
      (record) => record.recordId === pendingDispatch.dispatchToken,
    );
    return own === undefined ? undefined : readInterventionFormSettlement(own.outcome);
  }, [pendingDispatch, dispatchState.records, composedIdentity]);

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
      if (body.trim().length === 0) {
        publishForm((held) => ({
          ...held,
          localRefusal: refuse(
            RUN_INTERVENTION_REFUSAL_ORIGIN,
            "empty-directive",
            "There is nothing to steer with yet. Type what the run should do differently.",
          ),
        }));
        return;
      }
      const steer = (dispatcher: RunControlDispatcher): Promise<RunControlOutcome> =>
        dispatcher.steer({ runId: run.runId, expectedRunVersion: comparand }, { content: body });
      // Dispatch first, then record — and record nothing at all unless the dispatch state
      // admitted the call.
      const admission = dispatchState.dispatch(run.runId, "steer", steer);
      if (!admission.admitted) {
        publishForm((held) => ({ ...held, localRefusal: admissionRefusal(admission.reason) }));
        return;
      }
      publishForm((held) => ({
        ...held,
        localRefusal: undefined,
        pendingDispatch: { dispatchToken: admission.dispatchToken, composedIdentity },
      }));
    },
    [body, dispatchState, run.runId, comparand, isConfirmLatched, composedIdentity, publishForm],
  );

  return (
    <form className="meridian-run-composer" onSubmit={onSubmit}>
      <h4 className="meridian-run-composer__title">Steer this run</h4>
      <label className="meridian-run-composer__label" htmlFor={bodyId}>
        What should it do differently
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
          Send steer
        </button>
        <button type="button" className="meridian-run-composer__dismiss" onClick={onDismiss}>
          Cancel
        </button>
      </div>
    </form>
  );
}
