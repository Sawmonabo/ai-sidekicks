// The composer's one Send: the control, its dispatch, and the refusal beside it. It takes the
// two daemon calls a send makes, and the two a typed `/workflow run <name>` makes, as
// arguments, so a composition with none does not mount it. A press is `useSendController.ts`'s;
// Send derives no eligibility and the daemon refuses.
//
// The disabled button covers only the pointer path: a second press in the same frame reaches
// the handler, so the controller's synchronous latch is what holds inside one frame.

import { RefusalWithRemedy } from "../../components/RefusalWithRemedy/RefusalWithRemedy.js";
import type { ComposerProps } from "#renderer/registries/composer/registry.js";
import { useRefusalBannerEscalation } from "../../hooks/useRefusalBannerEscalation.js";
import { useComposerAddress } from "../../hooks/useComposerAddress.js";
import { useCommandHandling } from "../../command-list/hooks/useCommandHandling.js";
import { useWorkflowStartHandlers } from "../../command-list/workflow/hooks/useWorkflowStartHandlers.js";
import { type WorkflowStartOperations } from "../../command-list/workflow/start-from-line.js";
import type { ComposerSendCalls } from "../send/dispatch.js";
import { useSendController } from "../send/hooks/useSendController.js";
import { isUndeliveredMessage } from "../send/refusals.js";
import { NotDeliveredLine } from "../../components/NotDeliveredLine.js";

/** What Send is handed beyond the composer's own props. */
export type SendButtonProps = ComposerProps & {
  /** The two daemon calls a send makes. */
  readonly calls: ComposerSendCalls;
  /** The two calls a typed `/workflow run <name>` makes: the definition read and the start. */
  readonly workflowStartOperations: WorkflowStartOperations;
};

/** Send for the addressed draft, resolving to the wire call the addressed target admits. */
export function SendButton(props: SendButtonProps): React.JSX.Element {
  const target = useComposerAddress(props.sessionStore, props.focusedPane);
  // The handler a command that reads its arguments off the line runs with, so `/workflow run
  // <name>` starts the named workflow in this composer's session.
  const commandLineHandlers = useWorkflowStartHandlers({
    operations: props.workflowStartOperations,
    sessionId: props.sessionStore.sessionId,
  });
  // Recognizer and executor are supplied together by the zone that owns both.
  const commandZone = useCommandHandling({ route: props.route, commandLineHandlers });
  const controller = useSendController({
    bridge: props.bridge,
    calls: props.calls,
    target,
    draftStore: props.draftStore,
    recognizeConsoleCommand: commandZone.recognizeConsoleCommand,
    commandExecutor: commandZone.commandExecutor,
  });
  // A send that learned the session is gone also escalates to a frame banner; the hook decides
  // which codes qualify and raises each condition once.
  useRefusalBannerEscalation(props.frameStore, controller.refusal);
  const isSending = controller.status === "sending";

  return (
    <>
      <div className="meridian-composer__send-row">
        <button
          type="button"
          className="meridian-composer__primary meridian-action-button"
          aria-busy={isSending}
          disabled={isSending}
          onClick={() => {
            void controller.send();
          }}
        >
          {isSending ? "Sending" : "Send"}
        </button>
      </div>
      {controller.refusal === undefined ? null : isUndeliveredMessage(controller.refusal) ? (
        <NotDeliveredLine
          refusal={controller.refusal}
          onRetry={() => {
            void controller.send();
          }}
        />
      ) : (
        // Through the remedy join: `intervention.idempotency_conflict`, `run.version_conflict`
        // and `session.not_found` each have a next move the daemon's sentence lacks.
        <RefusalWithRemedy refusal={controller.refusal} />
      )}
    </>
  );
}
