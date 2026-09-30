// The composer's one Send: the control, its dispatch, and the refusal beside it. It takes the
// two daemon calls as an argument, so a composition with none does not mount it. A press is
// `useSendController.ts`'s; Send derives no eligibility and the daemon refuses.
//
// The disabled button covers only the pointer path: a second press in the same frame reaches
// the handler, so the controller's synchronous latch is what holds inside one frame.

import { useMemo } from "react";
import { RefusalWithRemedy } from "../../components/RefusalWithRemedy/RefusalWithRemedy.js";
import type { ComposerProps } from "@renderer/registries/composer/composer-registry.js";
import { useRefusalBannerEscalation } from "../../hooks/useRefusalBannerEscalation.js";
import { useComposerAddress } from "../../hooks/useComposerAddress.js";
import { useCommandHandling } from "../../command-list/hooks/useCommandHandling.js";
import { noComposerCommandLineHandlers } from "../../command-list/composer-command-line-handlers.js";
import type { ProviderCommandEnumeration } from "../../command-list/provider-command-enumeration.js";
import type { ComposerSendCalls } from "../send-dispatch.js";
import { useSendController } from "../hooks/useSendController.js";

/** What Send is handed beyond the composer's own props. */
export type SendButtonProps = ComposerProps & {
  /** The two daemon calls a send makes. */
  readonly calls: ComposerSendCalls;
  /**
   * The composer's one provider-command enumeration, opened by the command list. Read here, not
   * opened: a typed name the bound provider published is refused by name from the same reading
   * the popover shows.
   */
  readonly commandEnumeration: ProviderCommandEnumeration;
};

/** Send for the addressed draft, resolving to the wire call the addressed target admits. */
export function SendButton(props: SendButtonProps): React.JSX.Element {
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  // No handler for a command that reads its arguments off the line, so the executor leaves
  // such a line as typed. Stable, so the zone's latest-ref is not rewritten every render.
  const commandLineHandlers = useMemo(noComposerCommandLineHandlers, []);
  // Recognizer and executor are supplied together by the zone that owns both.
  const commandZone = useCommandHandling({
    route: props.route,
    commandEnumeration: props.commandEnumeration,
    // The address the send path acts on, so the published-name check uses the addressed run's
    // own binding.
    target: address.target,
    commandLineHandlers,
  });
  const controller = useSendController({
    bridge: props.bridge,
    calls: props.calls,
    target: address.target,
    draftStore: props.draftStore,
    recognizeClientCommand: commandZone.recognizeClientCommand,
    commandExecutor: commandZone.commandExecutor,
    recognizeProviderCommand: commandZone.recognizeProviderCommand,
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
      {controller.refusal === undefined ? null : (
        // Through the remedy join: `intervention.idempotency_conflict`, `run.version_conflict`
        // and `session.not_found` each have a next move the daemon's sentence lacks.
        <RefusalWithRemedy refusal={controller.refusal} />
      )}
    </>
  );
}
