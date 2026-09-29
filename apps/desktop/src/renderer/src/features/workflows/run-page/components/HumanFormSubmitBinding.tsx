// The submit channel the run pane keeps around the body that answers a waiting phase.
//
// WHAT IT IS FOR. A body that dispatched its own submission would author far more than a
// form: the submit call, the single-flight guard, the revision the attempt was composed
// against, the run read's re-arm, and the rendering of whatever the daemon said are all the
// pane's, and every one of them would have to be written again by whoever supplies a body.
// So they stay here, and what crosses into the body is one bound `submit` on its mount.
//
// A COMPONENT BETWEEN THE MOUNT AND THE BODY, rather than a hook in the slot above it. The
// submit is addressed by an attempt that exists only where a phase is open, so a hook in the
// wrapper would have to run on the render where nothing is waiting. `WorkflowSlotMount`
// renders only its empty frame on that arm, so the channel is mounted as the seat's body and
// the supplied body is composed inside it, which puts the hook behind the same absence check
// the empty frame is behind.
//
// THE ATTEMPT IS THE BODY'S KEY, AND IT HAS TO BE. A run that branches parks several
// phases on a person at once and the pane mounts ONE form; pressing another park card
// hands this component a different mount rather than unmounting it, so React reconciles
// the body in place and every state cell inside it survives the switch — two waits that
// share a member name would show one branch's typed answer under the other's question,
// and a press would record it against the phase now on screen. A key on `phaseRunId`
// makes them two elements, which is React's own way of saying they are two forms, and
// it is applied HERE so it holds for a supplied body as well as for the console's own shell.
//
// `phaseRunId` AND NOT THE PHASE, AND NOT THE REVISION EITHER. The attempt is what the
// answer is composed against and submitted for — a retry mints a new one — so it is the
// finest identity that is still stable while somebody types. `formRevision` moves
// underneath a live form whenever the run read refreshes, and keying on it would throw
// away typing in response to a poll; `phaseId` is the definition's and is reused by
// every attempt at that phase. The submit's own settlement is held at exactly this
// identity by `useSubjectScopedState`, so both halves of the form's state are scoped to
// one attempt by two mechanisms that agree rather than by one that covers half.
//
// THE OUTCOME STANDS BENEATH THE BODY. It is the seat's reading of what the daemon
// answered and not part of the form, so it sits under whatever the body drew rather than
// inside it — and a supplied body gets the settlement rendered for it without owning a
// line of it.

import { InlineRefusal, Nothing, WireFigure } from "@renderer/console/primitives/index.js";
import type { WorkflowHumanFormSubmitCall } from "../human-form-submit.js";
import { useHumanFormSubmit } from "../hooks/useHumanFormSubmit.js";
import { HumanFormShell } from "../default-human-form-body.js";
import type { HumanFormBody, HumanFormPhase } from "../human-form-mount.js";

/** What the slot hands this channel: the open phase, the body to mount, and the submit call. */
export interface HumanFormSubmitChannelProps {
  /** The wait this channel is the submit for. Present by construction — see the header. */
  readonly phase: HumanFormPhase;
  /**
   * The supplied body, or `undefined` while there is none and the console's shell stands.
   *
   * Required-carrying-undefined rather than optional, because the slot above always
   * knows which it has and an absent key would read as one that forgot to say.
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
export function HumanFormSubmitChannel(props: HumanFormSubmitChannelProps): React.JSX.Element {
  const { phase, body, submitForm } = props;
  const { outcome, submit } = useHumanFormSubmit(submitForm, phase);
  const MountedBody = body ?? HumanFormShell;
  return (
    <>
      <MountedBody key={phase.phaseRunId} {...phase} submit={submit} />
      {renderOutcome(outcome)}
    </>
  );
}

/**
 * What the daemon answered the last press, beneath the body that made it.
 *
 * A function rather than a second component in this file: it calls no hook and holds no
 * state, and one `.tsx` carries one component. `idle` draws NOTHING and that is not an
 * omission — a control nobody has pressed has no outcome, and an absence primitive there
 * would report on a question that was never put.
 */
function renderOutcome(outcome: ReturnType<typeof useHumanFormSubmit>["outcome"]): React.ReactNode {
  switch (outcome.kind) {
    case "idle":
      return null;
    case "submitting":
      // `not-loaded` and never `computing`: the answer is a round trip that has been put
      // and is still coming, rather than this console working something out.
      return <Nothing kind="not-loaded" placement="inline" title="Waiting for the daemon." />;
    case "submitted":
      return (
        // `role="status"` for the reason the workflow-start receipt carries one: the
        // press leaves focus on the submit control, the pending notice this replaces
        // says nothing on its own, and a settlement rendered as an ordinary paragraph
        // is therefore read by everyone who can see the screen and nobody else. The
        // region IS the sentence rather than a wrapper around it, so it speaks when the
        // outcome lands and stays silent through every re-render that does not move it
        // — a second element around this one would be a live region whose content
        // changed for reasons this arm did not.
        <p className="meridian-schema-answer__settlement" role="status">
          <WireFigure value={outcome.submittedAt} />
          <span>
            {outcome.outputCount === 1
              ? "The daemon recorded this answer and one output came of it."
              : `The daemon recorded this answer and ${String(outcome.outputCount)} outputs came of it.`}
          </span>
        </p>
      );
    case "refused":
      return <InlineRefusal code={outcome.refusal.code} detail={outcome.refusal.detail} />;
  }
}
