// The composer's one Send: the round control, its dispatch, and the refusal under the line. It
// takes the daemon call a send makes, and the two a typed `/workflow run <name>` makes, as
// arguments. A press, or Enter in the line, is `useSendController.ts`'s; Send dims while the
// message carries no words, no staged file and no composed notes, but derives no eligibility, and
// the daemon refuses.
//
// The disabled button covers only the pointer path: a second press in the same frame reaches
// the handler, so the controller's synchronous latch is what holds inside one frame.

import { useEffect, useSyncExternalStore } from "react";

import { RefusalWithRemedy } from "../../components/RefusalWithRemedy/RefusalWithRemedy.js";
import type { ComposerProps } from "#renderer/registries/composer/registry.js";
import { useRefusalBannerEscalation } from "../../hooks/useRefusalBannerEscalation.js";
import { useComposerAddress } from "../../hooks/useComposerAddress.js";
import { useCommandHandling } from "../../command-list/hooks/useCommandHandling.js";
import { useWorkflowStartHandlers } from "../../command-list/workflow/hooks/useWorkflowStartHandlers.js";
import { type WorkflowStartOperations } from "../../command-list/workflow/start-from-line.js";
import type { ComposerHeldDraft } from "../../held-draft/holder.js";
import type { ComposerSendCalls } from "../send/dispatch.js";
import { useSendController } from "../send/hooks/useSendController.js";
import { composerDraftKey } from "../draft-key.js";
import { useComposerDraftText } from "../../hooks/useComposerDraftText.js";
import { SendIconButton } from "../../components/SendIconButton.js";

/** What Send is handed beyond the composer's own props. */
export type SendButtonProps = ComposerProps & {
  /** The daemon call a send makes. */
  readonly calls: ComposerSendCalls;
  /** The two calls a typed `/workflow run <name>` makes: the definition read and the start. */
  readonly workflowStartOperations: WorkflowStartOperations;
  /** What rides with the words, which the send carries. */
  readonly heldDraft: ComposerHeldDraft;
  /** The composer region whose line sends on Enter. */
  readonly region: React.RefObject<HTMLElement | null>;
};

/** Send for the addressed draft, resolving to the wire call the addressed target admits. */
export function SendButton(props: SendButtonProps): React.JSX.Element {
  const target = useComposerAddress(props.sessionStore);
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
    heldDraft: props.heldDraft,
    recognizeConsoleCommand: commandZone.recognizeConsoleCommand,
    commandExecutor: commandZone.commandExecutor,
  });
  // A send that learned the session is gone also escalates to a frame banner; the hook decides
  // which codes qualify and raises each condition once.
  useRefusalBannerEscalation(props.frameStore, controller.refusal);
  const isSending = controller.status === "sending";
  // Subscribed so the circle dims and lights as the line empties and fills.
  const draft = useComposerDraftText(
    props.draftStore,
    composerDraftKey(props.sessionStore.sessionId),
  );
  const held = useSyncExternalStore(props.heldDraft.subscribe, props.heldDraft.snapshot);
  const carriesNothing =
    draft.text.trim().length === 0 && (held.extras.attachments ?? []).length === 0;
  useSendOnEnter(props.region, controller.send);

  return (
    <>
      <SendIconButton
        type="button"
        size="regular"
        isEmpty={carriesNothing}
        isSending={isSending}
        onPress={() => {
          void controller.send();
        }}
      />
      {controller.refusal === undefined ? null : (
        // Through the remedy join: a refusal such as `session.not_found` has a next move the
        // daemon's sentence lacks.
        <div className="meridian-composer__send-refusal">
          <RefusalWithRemedy refusal={controller.refusal} />
        </div>
      )}
    </>
  );
}

/** Send on Enter in the region's line; Shift+Enter and a key an input method composes do not. */
function useSendOnEnter(
  region: React.RefObject<HTMLElement | null>,
  send: () => Promise<void>,
): void {
  useEffect(() => {
    const element = region.current;
    if (element === null) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.isComposing ||
        event.target !== element.querySelector("textarea")
      ) {
        return;
      }
      event.preventDefault();
      void send();
    };
    element.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("keydown", onKeyDown);
    };
  }, [region, send]);
}
