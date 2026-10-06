// The palette's `/workflow run` over a line holding unsent words: asked in place, directly above
// the draft, never in a dialog over the screen. Nothing is written until the person answers.

import "./WorkflowStartPrefillQuestion.css";

import type { WorkflowStartPrefillPrompt } from "../hooks/useWorkflowStartPrefill.js";

/** The question while a prefill waits on the unsent words it would replace, otherwise nothing. */
export function WorkflowStartPrefillQuestion(props: {
  readonly prompt: WorkflowStartPrefillPrompt;
}): React.JSX.Element | null {
  const { prompt } = props;
  if (prompt.displacedText === undefined) {
    return null;
  }
  return (
    <div className="meridian-workflow-start-prefill" role="group" aria-label="Replace the draft">
      <p className="meridian-workflow-start-prefill__question">
        Replace the unsent message with /workflow run?
      </p>
      <button
        type="button"
        className="meridian-action-button meridian-action-button--small meridian-action-button--outline"
        onClick={prompt.keepLine}
      >
        Cancel
      </button>
      <button
        type="button"
        className="meridian-action-button meridian-action-button--small meridian-action-button--outline"
        onClick={prompt.replaceLine}
      >
        Replace
      </button>
    </div>
  );
}
