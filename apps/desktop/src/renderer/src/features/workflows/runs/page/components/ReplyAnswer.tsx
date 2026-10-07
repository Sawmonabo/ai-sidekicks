import { useId, useState } from "react";

import type { WorkflowStepQuestion } from "@ai-sidekicks/contracts/workflow/run/step/record";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useWorkflowCommandTarget } from "#renderer/features/workflows/hooks/useWorkflowCommandTarget.js";
import { useWorkflowCall } from "#renderer/features/workflows/hooks/useWorkflowCall.js";
import { useWorkflowCommandTargets } from "#renderer/features/workflows/hooks/useWorkflowCommandTargets.js";
import { receiptNow } from "../step/receipts.js";
import { ActionButton } from "#renderer/features/workflows/components/ActionButton.js";

/** Why `Answer this run` cannot answer a reply wait with nothing typed in it. */
const REPLY_EMPTY = "This step waits for a reply. Type one, then answer.";

/**
 * A step waiting for a chat reply, answered in its step panel: the question, one free-text row
 * and `Answer`, with no `Skip`. It answers the same question record the session's question card
 * does, so the first answer through either settles the wait in both places. Its receipt stands
 * at once, then from the record the daemon keeps. `Answer this run` presses `Answer` once a reply
 * is typed.
 */
export function ReplyAnswer(props: {
  readonly question: WorkflowStepQuestion;
  readonly bridge: PlatformBridge;
  /** Called with the receipt once the daemon has taken the answer. */
  readonly onAnswered: (receipt: string) => void;
}): React.JSX.Element | null {
  const { question, bridge } = props;
  const fieldId = useId();
  const clock = useClock();
  const clockLocale = useClockLocale();
  const [text, setText] = useState("");
  const answer = useWorkflowCall(
    (typed: string) =>
      callDaemon(bridge, "question.resolve", {
        questionId: question.questionId,
        answers: [{ kind: "typed", text: typed }],
      }),
    () => {
      // The question's answer carries no instant; the daemon's own record replaces this one.
      props.onAnswered(receiptNow("answered", clock.now(), clockLocale));
    },
  );
  const isSending = answer.state.kind === "sending";
  const commandTargets = useWorkflowCommandTargets();
  useWorkflowCommandTarget(commandTargets.answerThisRun, {
    unavailable: () => (text.trim() === "" ? REPLY_EMPTY : undefined),
    take: () => {
      if (answer.state.kind === "idle" || answer.state.kind === "refused") {
        answer.take(text.trim());
      }
    },
  });
  if (answer.state.kind === "done") {
    return null;
  }
  return (
    <form
      className="meridian-workflow-step__answer meridian-workflow-step__reply"
      onSubmit={(event) => {
        event.preventDefault();
        answer.take(text.trim());
      }}
    >
      <label className="meridian-workflow-step__question" htmlFor={fieldId}>
        {question.prompt}
      </label>
      <input
        id={fieldId}
        className="meridian-workflow-step__reply-field meridian-form__input"
        value={text}
        disabled={isSending}
        onChange={(event) => {
          setText(event.currentTarget.value);
        }}
      />
      <ActionButton type="submit" tone="primary" disabled={isSending || text.trim() === ""}>
        Answer
      </ActionButton>
      {answer.state.kind === "refused" ? (
        <InlineRefusal code={answer.state.refusal.code} detail={answer.state.refusal.detail} />
      ) : null}
    </form>
  );
}
