// The composer's input and its one primary action.
//
// Send resolves to the one wire call the addressed target admits, and the refusal
// that comes back sits beside the control that produced it rather than replacing it.
//
// ONE SEND BUTTON, NO MODE. Send never becomes anything else, and the composer carries
// no Stop: interrupting a turn is the working line's. Send derives no eligibility;
// the daemon refuses, which is the fail-closed direction.
//
// THE DISABLED BUTTON COVERS THE POINTER PATH AND ONLY THAT PATH. A read-only
// textarea still receives key events, so an Enter repeat or a second press before
// settlement reaches this handler with nothing in the DOM to stop it. The keyboard
// gate below is the render-state half of the guard; the half that holds inside one
// frame is the controller's synchronous latch, because this handler reads the status
// from the render that produced it.
//
// The component renders and does nothing else — the state, the router, and the
// history walk are `send-controller.ts`'s, so what is left here is markup, keyboard
// wiring, and the two absences this surface can honestly show.
//
// THE LINE'S TEXT IS THE DRAFT STORE'S. The seat is handed a window-lifetime store
// and this bar neither owns the body nor copies it.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { RefusalCard, RemediedRefusal } from "../../../console/primitives/index.js";
import { subscribeToComposerFocus, type ComposerSeatProps } from "../../../console/seats/index.js";
import { useRefusalBannerEscalation } from "../../../console/store/index.js";
import { COMPOSER_DIRECTIVE_LINE_MAX_ROWS } from "../composer-bounds.js";
import { useComposerAddress } from "../composer-address.js";
import { readTextNeutralization } from "../neutralization-tripwire.js";
import { useComposerCommandZone } from "../commands/client-command-executor.js";
import { noDirectiveLineHandlers } from "../commands/directive-line-handlers.js";
import type { ProviderCommandEnumeration } from "../commands/provider-command-holder.js";
import { useSendController } from "./send-controller.js";

export type ComposerSendBarProps = ComposerSeatProps & {
  /**
   * The composer's one enumeration reading, opened by the discovery surface.
   *
   * Read and never opened here: a typed name that the bound provider published is
   * refused by name rather than sent, and the reading that answers is the same one
   * the popover is showing — not a second read of the same wire.
   */
  readonly commandEnumeration: ProviderCommandEnumeration;
};

export function ComposerSendBar(props: ComposerSendBarProps): React.JSX.Element {
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  // No command here reads its arguments off the line yet; the map is stable so the
  // zone's latest-ref is not rewritten on every render.
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
    target: address.target,
    draftStore: props.draftStore,
    recognizeClientCommand: commandZone.recognizeClientCommand,
    commandExecutor: commandZone.commandExecutor,
    recognizeProviderCommand: commandZone.recognizeProviderCommand,
  });
  // A SEND THAT LEARNED THE SESSION IS GONE IS NOT THIS BAR'S NEWS ALONE. The refusal
  // still renders below, beside the control that produced it — that is where a person
  // pressing Send looks — but the remedy table calls `session.not_found` a workspace
  // banner, and until this handover the composer was the one surface that could learn
  // it and never told the frame: every pane went on drawing a session that had left
  // the node. The hook decides which codes qualify and raises each condition once, so
  // nothing here reads the table and a dismissed banner stays dismissed.
  useRefusalBannerEscalation(props.frameStore, controller.refusal);
  const isSending = controller.status === "sending";
  const isProviderBound = address.target.path === "provider-bound";

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const line = event.currentTarget;
      const caret = {
        selectionStart: line.selectionStart,
        selectionEnd: line.selectionEnd,
        textLength: line.value.length,
      };
      if (event.key === "Enter" && !event.shiftKey) {
        // Always swallowed, sending or not: a read-only textarea still receives key
        // events, so letting the default through while a send is in flight would put
        // a newline into a line the person believes is locked.
        event.preventDefault();
        if (isSending) {
          return;
        }
        void controller.send();
        return;
      }
      if (isSending) {
        // Everything past this point WRITES the line. A read-only textarea still
        // receives key events, so an unguarded recall would swap the text under a
        // person who cannot type into it — and it would advance the walk's cursor
        // besides, so the draft they left is not the draft they come back to once
        // the send settles. Nothing is swallowed here: the arrows stay the caret's,
        // which is movement a read-only line still permits.
        return;
      }
      // The arrows recall only at the edge offsets, and only when there is something
      // to recall — otherwise they stay the caret's, which is what they are for
      // everywhere else in the input.
      if (event.key === "ArrowUp" && controller.recallOlder(caret)) {
        event.preventDefault();
        return;
      }
      if (event.key === "ArrowDown" && controller.recallNewer(caret)) {
        event.preventDefault();
      }
    },
    [controller, isSending],
  );

  const neutralization = readTextNeutralization(
    isProviderBound ? address.target.providerFailureDetail : undefined,
  );

  // The seat's other direction. A surface elsewhere in the window — the runs pane's
  // empty state is the first — tells a person to send a message; this is what makes
  // that sentence actionable from where they are standing. The ask carries nothing,
  // so what focusing means stays this component's decision, and an ask that arrives
  // while no composer is mounted reaches nobody rather than queueing.
  const lineRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(
    () =>
      subscribeToComposerFocus(() => {
        lineRef.current?.focus();
      }),
    [],
  );

  return (
    <div className="meridian-composer__send">
      <textarea
        ref={lineRef}
        className="meridian-composer__line"
        aria-label="Message"
        placeholder={controller.placeholder}
        value={controller.text}
        rows={1}
        // The growth cap: the line grows to it and then scrolls inside its own box,
        // so the ledger above keeps its room.
        style={{ maxHeight: `calc(${String(COMPOSER_DIRECTIVE_LINE_MAX_ROWS)} * 1.5em)` }}
        readOnly={isSending}
        onChange={(event) => {
          controller.changeText(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
      />
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
      {neutralization === undefined ? null : (
        <RefusalCard code={neutralization.code} detail={neutralization.wireDetail} />
      )}
    </div>
  );
}
