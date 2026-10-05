import { useState } from "react";

import type { ApprovalDecision } from "@ai-sidekicks/contracts/approval";
import type {
  WorkflowChainQuestion,
  WorkflowChainRoot,
} from "@ai-sidekicks/contracts/workflow/run/records";

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { formatCount, formatDayClock } from "@renderer/lib/wire-figures.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useWorkflowCommandTarget } from "../../hooks/useWorkflowCommandTarget.js";
import { useWorkflowAct } from "../../hooks/useWorkflowAct.js";
import { ActionButton } from "../../components/ActionButton.js";
import { answerThisRunTarget } from "../../workflow-command-target.js";
import { chainReceipt } from "../step-receipts.js";

/** The chain question's two answers, in the order they stand, and the approval each one is. */
const CHAIN_ANSWERS: readonly { readonly label: string; readonly decision: ApprovalDecision }[] = [
  { label: "Keep going", decision: "approved" },
  { label: "Stop them all", decision: "rejected" },
];

/**
 * The chain's question on its first run's page, naming the first run's workflow, the chain's run
 * count and the first run's start, with `Keep going` and `Stop them all`, answered as the approval
 * the engine raised on this run; `Keep going` is what `Answer this run` presses. Once answered it
 * is a one-line receipt with no way back, drawn at once and then from the daemon's record.
 */
export function ChainQuestion(props: {
  readonly question: WorkflowChainQuestion;
  readonly chainRoot: WorkflowChainRoot;
  readonly bridge: PlatformBridge;
  /** The instant the first run's start is counted from, for its day. */
  readonly nowMs: number;
  /** Called once the daemon has taken the answer. */
  readonly onAnswered: () => void;
}): React.JSX.Element {
  const { question } = props;
  return question.state === "answered" ? (
    <ChainReceipt answered={question} />
  ) : (
    <OpenChainQuestion
      chainRoot={props.chainRoot}
      bridge={props.bridge}
      nowMs={props.nowMs}
      onAnswered={props.onAnswered}
    />
  );
}

/** A chain question once answered. */
type AnsweredChainQuestion = Extract<WorkflowChainQuestion, { state: "answered" }>;

function ChainReceipt(props: { readonly answered: AnsweredChainQuestion }): React.JSX.Element {
  return <p className="meridian-workflow-run__chain-receipt">{chainReceipt(props.answered)}</p>;
}

function OpenChainQuestion(props: {
  readonly chainRoot: WorkflowChainRoot;
  readonly bridge: PlatformBridge;
  readonly nowMs: number;
  readonly onAnswered: () => void;
}): React.JSX.Element {
  const { chainRoot, bridge } = props;
  const [answered, setAnswered] = useState<AnsweredChainQuestion | undefined>();
  const answer = useWorkflowAct(
    (decision: ApprovalDecision) =>
      callDaemon(bridge, "workflow.gateResolve", {
        workflowRunId: chainRoot.runId,
        decision,
      }),
    (resolved, decision) => {
      setAnswered({
        state: "answered",
        decision,
        runCount: chainRoot.runCount,
        answeredAt: resolved.decidedAt,
      });
      props.onAnswered();
    },
  );
  useWorkflowCommandTarget(answerThisRunTarget, () => {
    if (answer.state.kind === "idle" || answer.state.kind === "refused") {
      answer.take("approved");
    }
    return undefined;
  });
  if (answered !== undefined) {
    // The receipt stands at once; the run reading back answered then draws the same line.
    return <ChainReceipt answered={answered} />;
  }
  const sentence =
    `${chainRoot.workflowName} has started ${formatCount(chainRoot.runCount)} runs from its ` +
    `${formatDayClock(chainRoot.startedAt, props.nowMs)} start. Keep going?`;
  return (
    <div className="meridian-workflow-run__chain-question" role="group" aria-label={sentence}>
      <p className="meridian-workflow-run__chain-sentence">{sentence}</p>
      <div className="meridian-workflow-run__chain-answers">
        {CHAIN_ANSWERS.map(({ label, decision }) => (
          <ActionButton
            key={decision}
            tone={decision === "approved" ? "primary" : "outline"}
            disabled={answer.state.kind === "sending"}
            onClick={() => {
              answer.take(decision);
            }}
          >
            {label}
          </ActionButton>
        ))}
      </div>
      {answer.state.kind === "refused" ? (
        <InlineRefusal code={answer.state.refusal.code} detail={answer.state.refusal.detail} />
      ) : null}
    </div>
  );
}
