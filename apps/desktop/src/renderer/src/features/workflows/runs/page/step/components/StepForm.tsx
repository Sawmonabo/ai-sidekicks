import { useId } from "react";

import type { WorkflowStepKey } from "@ai-sidekicks/contracts/workflow/run/step";

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { ParamForm } from "#renderer/features/workflows/param-form/ParamForm.js";
import { useWorkflowCommandTarget } from "#renderer/features/workflows/hooks/useWorkflowCommandTarget.js";
import { useWorkflowCommandTargets } from "#renderer/features/workflows/hooks/useWorkflowCommandTargets.js";
import { useStepForm } from "../hooks/useStepForm.js";
import { ActionButton } from "#renderer/features/workflows/components/ActionButton.js";

/**
 * A step blocked on a form, answered in the step panel: the node's prompt over one field per
 * entry of its input, and `Submit`, which is what `Answer this run` presses. Until the form is
 * read it reads `Loading the form…`; a read that fails reads `Could not load the form` with
 * `Try again`.
 */
export function StepForm(props: {
  readonly bridge: PlatformBridge;
  readonly stepKey: WorkflowStepKey;
  readonly onAnswered: (receipt: string) => void;
}): React.JSX.Element {
  const idPrefix = useId();
  const clock = useClock();
  const form = useStepForm(props.bridge, props.stepKey, props.onAnswered);
  const { read } = form;
  // The form is offered only once it has been read, so a press made while it loads waits for it.
  const commandTargets = useWorkflowCommandTargets();
  useWorkflowCommandTarget(
    commandTargets.answerThisRun,
    { unavailable: () => undefined, take: form.submit },
    "control",
    read.kind === "read",
  );
  if (read.kind === "reading") {
    return <LoadingNotice clock={clock} placement="block" title="Loading the form…" />;
  }
  if (read.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="block"
        title="Could not load the form"
        detail={read.refusal.detail}
        action={<TryAgainButton onPress={form.readAgain} />}
      />
    );
  }
  const isSending = form.submitState.kind === "sending";
  return (
    <form
      className="meridian-workflow-step__form"
      onSubmit={(event) => {
        event.preventDefault();
        form.submit();
      }}
    >
      <p className="meridian-workflow-step__prompt">{read.form.prompt}</p>
      <ParamForm
        fields={read.form.fields}
        answers={form.answers}
        onAnswersChange={form.changeAnswers}
        issues={form.issues}
        isDisabled={isSending}
        idPrefix={idPrefix}
        pickFolder={() => props.bridge.native.showOpenDialog({ purpose: "pickFolder" })}
      />
      {form.draftRefusal === undefined ? null : (
        <InlineRefusal code={form.draftRefusal.code} detail={form.draftRefusal.detail} />
      )}
      <div className="meridian-workflow-step__answer">
        <ActionButton type="submit" tone="primary" disabled={isSending}>
          Submit
        </ActionButton>
        {form.submitState.kind === "refused" ? (
          <InlineRefusal
            code={form.submitState.refusal.code}
            detail={form.submitState.refusal.detail}
          />
        ) : null}
      </div>
    </form>
  );
}
