import type { ApprovalDecision } from "@ai-sidekicks/contracts/approval";
import type { WorkflowNodeId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/status";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { callDaemon } from "#renderer/services/daemon/daemon-reply.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { useWorkflowCommandTarget } from "#renderer/features/workflows/hooks/useWorkflowCommandTarget.js";
import { useWorkflowCall } from "#renderer/features/workflows/hooks/useWorkflowCall.js";
import { useWorkflowCommandTargets } from "#renderer/features/workflows/hooks/useWorkflowCommandTargets.js";
import { resolutionReceipt } from "../step/receipts.js";
import { ActionButton } from "#renderer/features/workflows/components/ActionButton.js";

/**
 * A step blocked on an approval, answered where it stands: `Reject` and `Approve`. The answer
 * replaces both with a one-line past-tense receipt, `Approved at 2:14 PM`, which has no way back;
 * the run's own Cancel and Resume are what act next. `Approve` is what `Answer this run` presses.
 */
export function ApprovalAnswer(props: {
  readonly workflowRunId: WorkflowRunId;
  readonly nodeId: WorkflowNodeId;
  readonly bridge: PlatformBridge;
  /** Called with the receipt once the daemon has recorded the answer. */
  readonly onAnswered: (receipt: string) => void;
}): React.JSX.Element {
  const { workflowRunId, nodeId, bridge } = props;
  const clock = useClock();
  const answer = useWorkflowCall(
    (decision: ApprovalDecision) =>
      callDaemon(bridge, "workflow.gateResolve", { workflowRunId, nodeId, decision }),
    (resolved, decision) => {
      props.onAnswered(resolutionReceipt({ kind: decision, at: resolved.decidedAt }, clock.now()));
    },
  );
  const isSending = answer.state.kind === "sending";
  const commandTargets = useWorkflowCommandTargets();
  useWorkflowCommandTarget(commandTargets.answerThisRun, () => {
    if (!isSending) {
      answer.take("approved");
    }
    return undefined;
  });
  return (
    <div className="meridian-workflow-step__answer" role="group" aria-label="Answer this approval">
      <ActionButton
        disabled={isSending}
        onClick={() => {
          answer.take("rejected");
        }}
      >
        Reject
      </ActionButton>
      <ActionButton
        tone="primary"
        disabled={isSending}
        onClick={() => {
          answer.take("approved");
        }}
      >
        Approve
      </ActionButton>
      {answer.state.kind === "refused" ? (
        <InlineRefusal code={answer.state.refusal.code} detail={answer.state.refusal.detail} />
      ) : null}
    </div>
  );
}
