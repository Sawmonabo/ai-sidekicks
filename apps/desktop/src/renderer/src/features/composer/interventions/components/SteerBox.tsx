// A child's steer box: a body typed against one run, sent as a message on the child's own queue.
//
// All form state sits in one subject-scoped holder keyed by run id, so it re-seeds during the
// render that first sees a new run and a submit never sends text written for another run. A steer
// is a queue send, so the form closes once the dispatch recorded under its own token settles; a
// refused send records nothing, and the form keeps the text and says why.

import { useCallback, useEffect, useRef } from "react";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { TextBox } from "#renderer/components/TextBox/TextBox.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";
import { RUN_INTERVENTION_REFUSAL_ORIGIN, admissionRefusal } from "../refusals.js";
import type { RunControlCommandRun } from "../../run/controls/contributions/commands.js";
import type {
  RunControlDispatcher,
  RunControlOutcome,
} from "../../run/controls/services/dispatch.js";
import type { RunControlDispatchState } from "../../run/controls/hooks/useRunControlDispatch.js";

import "./SteerBox.css";

/**
 * What the steer box is given: the run it addresses, the child of that run whose queue takes the
 * message, the agent it is named for, and the dispatch state it goes through.
 */
export interface SteerBoxProps {
  /** The transport this form's state is scoped to; a replacement retires that state. */
  readonly bridge: PlatformBridge;
  readonly run: RunControlCommandRun;
  /** The daemon's handle for the child the box steers. */
  readonly childHandle: string;
  /** The agent the box steers, as the transcript names it: `Steer <name>`. */
  readonly agentName: string;
  readonly dispatchState: RunControlDispatchState;
  /** Close the box. Raised once the steer is sent. */
  readonly onDismiss: () => void;
}

/** The dispatch this form is waiting on, named by the token the dispatch state admitted. */
interface PendingDispatch {
  /** The token this form's own settlement will be recorded under. */
  readonly dispatchToken: string;
  /**
   * The run this dispatch was raised for, so the one render between a run change and the reset
   * cannot read the previous run's settlement as this one's.
   */
  readonly composedIdentity: string;
}

/** Everything the form holds about one run, in one value so one run change resets all of it. */
interface ComposedForm {
  readonly body: string;
  readonly localRefusal: Refusal | undefined;
  readonly pendingDispatch: PendingDispatch | undefined;
  /**
   * Whether the form has already asked to be closed. The records list keeps changing, so
   * without this the form would keep asking a parent that has stopped rendering it. Held here,
   * not in a ref, so a new run can close again.
   */
  readonly hasAskedToClose: boolean;
}

const EMPTY_FORM: ComposedForm = Object.freeze({
  body: "",
  localRefusal: undefined,
  pendingDispatch: undefined,
  hasAskedToClose: false,
});

/** The box that sends a steer to one run. */
export function SteerBox(props: SteerBoxProps): React.JSX.Element {
  const { bridge, run, childHandle, agentName, dispatchState, onDismiss } = props;
  const comparand = dispatchState.dispatcher.comparandFor(run.runId, run.runVersion);
  const composedIdentity = run.runId;
  const { value: form, publish: publishForm } = useSubjectScopedState<ComposedForm>(
    bridge,
    composedIdentity,
    () => EMPTY_FORM,
  );
  const { body, localRefusal, pendingDispatch } = form;
  // `Retry` submits the form, so a retry takes the same path, latch and checks as Send.
  const formRef = useRef<HTMLFormElement>(null);

  const publishBody = useCallback(
    (next: string) => {
      publishForm((held) => ({ ...held, body: next }));
    },
    [publishForm],
  );

  // Read off the record whose id is this form's dispatch token, so another request's
  // settlement is never mistaken for it.
  const hasLanded =
    pendingDispatch !== undefined &&
    pendingDispatch.composedIdentity === composedIdentity &&
    dispatchState.records.some((record) => record.recordId === pendingDispatch.dispatchToken);
  const isSending = pendingDispatch !== undefined && !hasLanded;

  const hasAskedToClose = form.hasAskedToClose;
  useEffect(() => {
    if (hasLanded && !hasAskedToClose) {
      publishForm((held) => ({ ...held, hasAskedToClose: true }));
      onDismiss();
    }
  }, [hasLanded, hasAskedToClose, publishForm, onDismiss]);

  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSending) {
        // A latched confirm is still reachable by Enter in a field; a second dispatch of one body
        // would queue it twice.
        return;
      }
      if (body.trim().length === 0) {
        publishForm((held) => ({
          ...held,
          localRefusal: refuse(
            RUN_INTERVENTION_REFUSAL_ORIGIN,
            "empty-steer",
            "There is nothing to steer with yet. Type what the run should do differently.",
          ),
        }));
        return;
      }
      const steer = (dispatcher: RunControlDispatcher): Promise<RunControlOutcome> =>
        dispatcher.steer(
          { runId: run.runId, expectedRunVersion: comparand },
          { childHandle, content: body },
        );
      // Nothing is recorded unless the dispatch state admitted the call.
      const admission = dispatchState.dispatch(run.runId, "steer", steer);
      if (!admission.admitted) {
        publishForm((held) => ({ ...held, localRefusal: admissionRefusal(admission.reason) }));
        return;
      }
      const { dispatchToken } = admission;
      publishForm((held) => ({
        ...held,
        localRefusal: undefined,
        pendingDispatch: { dispatchToken, composedIdentity },
      }));
      // A rejected call records nothing, so the form leaves its latch and holds the rejection.
      void admission.settled.catch((rejection: unknown) => {
        publishForm((held) =>
          held.pendingDispatch?.dispatchToken === dispatchToken
            ? {
                ...held,
                pendingDispatch: undefined,
                localRefusal: normalizeWireRejection(RUN_INTERVENTION_REFUSAL_ORIGIN, rejection),
              }
            : held,
        );
      });
    },
    [
      body,
      dispatchState,
      run.runId,
      comparand,
      childHandle,
      isSending,
      composedIdentity,
      publishForm,
    ],
  );

  return (
    <form ref={formRef} className="meridian-run-composer" onSubmit={onSubmit}>
      <TextBox
        className="meridian-run-composer__body meridian-form__input"
        fieldClassName="meridian-form__text-area"
        aria-label={`Steer ${agentName}`}
        placeholder={`Steer ${agentName}…`}
        value={body}
        rows={3}
        onChange={(event) => {
          publishBody(event.target.value);
        }}
      />
      {localRefusal === undefined ? null : (
        <InlineRefusal
          code={localRefusal.code}
          detail={localRefusal.detail}
          attempt={localRefusal}
        />
      )}
      <div className="meridian-run-composer__actions">
        <button
          type="submit"
          className={
            "meridian-action-button " +
            "meridian-action-button--small meridian-action-button--raised"
          }
          disabled={isSending}
          aria-busy={isSending}
        >
          Send
        </button>
      </div>
    </form>
  );
}
