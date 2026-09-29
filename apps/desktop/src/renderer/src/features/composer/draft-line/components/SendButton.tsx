// The composer's one Send: the control, its dispatch, and the refusal beside it.
//
// It takes the two daemon calls a send makes as an argument, so a composition that has
// none to give does not mount it. Everything a press does is `send-controller.ts`'s:
// the router resolves the addressed draft to the one wire call the target admits, and
// the refusal that comes back sits beside the control that produced it rather than
// replacing it.
//
// ONE SEND BUTTON, NO MODE. Send never becomes anything else, and the composer carries
// no Stop: interrupting a turn is the working line's. Send derives no eligibility; the
// daemon refuses, which is the fail-closed direction.
//
// THE DISABLED BUTTON COVERS THE POINTER PATH AND ONLY THAT PATH. A second press before
// settlement reaches this handler with nothing in the DOM to stop it when it arrives in
// the same frame, so the half that holds inside one frame is the controller's
// synchronous latch: this handler reads the status from the render that produced it.

import { useMemo } from "react";
import { RemediedRefusal } from "@renderer/console/primitives/index.js";
import type { ComposerSeatProps } from "@renderer/console/seats/index.js";
import { useRefusalBannerEscalation } from "@renderer/console/store/shell/refusal-escalation.js";
import { useComposerAddress } from "../../hooks/useComposerAddress.js";
import { useComposerCommandZone } from "@renderer/shell/composer/commands/client-command-executor.js";
import { noDirectiveLineHandlers } from "../../command-list/composer-command-line-handlers.js";
import type { ProviderCommandEnumeration } from "@renderer/shell/composer/commands/provider-command-holder.js";
import type { ComposerSendCalls } from "../send-dispatch.js";
import { useSendController } from "../hooks/useSendController.js";

/** What Send is handed beyond the seat's own props. */
export type SendButtonProps = ComposerSeatProps & {
  /** The two daemon calls a send makes. */
  readonly calls: ComposerSendCalls;
  /**
   * The composer's one enumeration reading, opened by the discovery surface.
   *
   * Read and never opened here: a typed name that the bound provider published is
   * refused by name rather than sent, and the reading that answers is the same one
   * the popover is showing — not a second read of the same wire.
   */
  readonly commandEnumeration: ProviderCommandEnumeration;
};

/** Send for the addressed draft, resolving to the wire call the addressed target admits. */
export function SendButton(props: SendButtonProps): React.JSX.Element {
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  // No handler is supplied for a command that reads its arguments off the line, so the
  // executor leaves such a line as typed. The map is stable so the zone's latest-ref is
  // not rewritten on every render.
  const directiveHandlers = useMemo(noDirectiveLineHandlers, []);
  // BOTH HALVES OR NEITHER. The router will not intercept a name its recogniser does
  // not claim, and an intercepted name with no executor refuses rather than running,
  // so the two are supplied together by the zone that owns both.
  const commandZone = useComposerCommandZone({
    route: props.route,
    commandEnumeration: props.commandEnumeration,
    // The same address the send path acts on, so the name this zone recognises as
    // published comes from the addressed run's own binding and not from a sibling
    // binding the same agent happens to hold.
    target: address.target,
    directiveHandlers,
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
  // A SEND THAT LEARNED THE SESSION IS GONE IS NOT THIS BUTTON'S NEWS ALONE. The refusal
  // still renders below, beside the control that produced it — that is where a person
  // pressing Send looks — but the remedy table calls `session.not_found` a workspace
  // banner, so the frame is told too: every pane is drawing a session that has left the
  // node. The hook decides which codes qualify and raises each condition once, so
  // nothing here reads the table and a dismissed banner stays dismissed.
  useRefusalBannerEscalation(props.frameStore, controller.refusal);
  const isSending = controller.status === "sending";

  return (
    <>
      <div className="meridian-composer__send-row">
        <button
          type="button"
          className="meridian-composer__primary"
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
        // Through the remedy join rather than straight to the inline shape: the
        // send router reaches `intervention.idempotency_conflict`,
        // `run.version_conflict`, and `session.not_found`, and each of those has a
        // next move the daemon's own sentence does not carry.
        <RemediedRefusal refusal={controller.refusal} />
      )}
    </>
  );
}
