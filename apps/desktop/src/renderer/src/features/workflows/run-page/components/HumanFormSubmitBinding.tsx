// The submit channel the run pane keeps around the body that answers a waiting phase. The submit
// call, single-flight guard, captured revision, run-read re-arm and settlement rendering stay
// with the pane, so a supplied body receives one bound `submit`.
//
// It is a component between the mount and the body, not a hook in the mount point, because the
// attempt exists only where a phase is open and `EngineMountPoint` renders only its empty frame
// otherwise. The body is keyed on `phaseRunId`: a run that branches parks several phases on a
// person, and without the key React would reuse one form's state under the next branch's
// question. `formRevision` moves under a live form on every refresh, and `phaseId` is reused by
// every attempt at that phase, so `phaseRunId` is the finest identity stable while typing.

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { WorkflowHumanFormSubmitCall } from "../human-form-submit.js";
import { useHumanFormSubmit } from "../hooks/useHumanFormSubmit.js";
import { DefaultHumanFormBody } from "../default-human-form-body.js";
import type { HumanFormBody, HumanFormPhase } from "../human-form-mount.js";

/** What the mount point hands this channel: the open phase, the body to mount, the submit call. */
export interface HumanFormSubmitBindingProps {
  /** The wait this channel is the submit for. */
  readonly phase: HumanFormPhase;
  /**
   * The supplied body, or `undefined` while the console's default body stands. Required rather
   * than optional so the mount point states which it has.
   */
  readonly body: HumanFormBody | undefined;
  /**
   * The call that submits this phase's form.
   *
   * Pass a stable function: a new identity starts the open attempt over.
   */
  readonly submitForm: WorkflowHumanFormSubmitCall;
}

/** The waiting phase's body, with the pane's submit bound to it and its answer beneath. */
export function HumanFormSubmitBinding(props: HumanFormSubmitBindingProps): React.JSX.Element {
  const { phase, body, submitForm } = props;
  const { outcome, submit } = useHumanFormSubmit(submitForm, phase);
  const MountedBody = body ?? DefaultHumanFormBody;
  return (
    <>
      <MountedBody key={phase.phaseRunId} {...phase} submit={submit} />
      {renderOutcome(outcome)}
    </>
  );
}

/**
 * What the daemon answered the last press, beneath the body that made it. `idle` draws nothing:
 * an unpressed control has no outcome to report.
 */
function renderOutcome(outcome: ReturnType<typeof useHumanFormSubmit>["outcome"]): React.ReactNode {
  switch (outcome.kind) {
    case "idle":
      return null;
    case "submitting":
      // `not-loaded`, not `computing`: the answer is a round trip still coming.
      return (
        <Nothing kind="not-loaded" placement="inline" title="Waiting for the background service." />
      );
    case "submitted":
      return (
        // `role="status"` because the press leaves focus on the submit control, so an ordinary
        // paragraph would be read by sighted users only. The region is the sentence itself, so it
        // speaks when the outcome lands and stays silent through unrelated re-renders.
        <p className="meridian-schema-answer__settlement" role="status">
          <WireFigure value={outcome.submittedAt} />
          <span>
            {outcome.outputCount === 1
              ? "The background service recorded this answer and one output came of it."
              : `The background service recorded this answer and ${String(outcome.outputCount)} outputs came of it.`}
          </span>
        </p>
      );
    case "refused":
      return <InlineRefusal code={outcome.refusal.code} detail={outcome.refusal.detail} />;
  }
}
